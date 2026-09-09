(function(exports, metro, common, patcher, assets, components, toasts, utils) {
"use strict";

const { findByProps, findByStoreName } = metro;
const { clipboard, FluxDispatcher, React } = common;
const { after, before } = patcher;
const { getAssetIDByName } = assets;
const { Forms } = components;
const { showToast } = toasts;
const { findInReactTree } = utils;

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow ?? Forms.FormRow;
const MessageStore = findByStoreName("MessageStore");

const selected = new Map();
const visualOriginals = new Map();
const patchedHandlers = new Set();

const BLUE_MARKER = "🔵 ";

let selectionMode = false;
let selectionChannelId = null;
let actionSheetUnpatches = [];
let handlerUnpatches = [];
let getterRestorers = [];
let hookedPrototype = null;

const copyIcon = () => getAssetIDByName("ic_message_copy");

function toast(text) {
    try {
        showToast(text, copyIcon());
    } catch (_) {
        try { showToast(text); } catch (_) {}
    }
}

function getMessage(channelId, messageId, fallback) {
    return MessageStore?.getMessage?.(channelId, messageId) ?? fallback ?? null;
}

function channelOf(message) {
    return message?.channel_id ?? message?.channelId ?? null;
}

function messageKey(message) {
    return `${channelOf(message)}:${message?.id}`;
}

function cleanSnapshot(message) {
    const channelId = channelOf(message);
    const key = `${channelId}:${message?.id}`;
    return {
        ...message,
        channel_id: channelId,
        content: visualOriginals.get(key) ?? message?.content ?? ""
    };
}

function paintMessage(message, enabled) {
    const channelId = channelOf(message);
    if (!message?.id || !channelId || !FluxDispatcher?.dispatch) return;

    const normalized = { ...message, channel_id: channelId };
    const key = messageKey(normalized);
    const current = getMessage(channelId, message.id, normalized) ?? normalized;

    if (enabled) {
        if (!visualOriginals.has(key)) {
            let original = typeof current.content === "string" ? current.content : "";
            if (original.startsWith(BLUE_MARKER)) original = original.slice(BLUE_MARKER.length);
            visualOriginals.set(key, original);
        }

        const original = visualOriginals.get(key) ?? "";
        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: {
                ...current,
                content: `${BLUE_MARKER}${original}`,
                __telegramSelectionVisual: true
            },
            otherPluginBypass: true
        });
        return;
    }

    if (!visualOriginals.has(key)) return;

    const original = visualOriginals.get(key) ?? "";
    FluxDispatcher.dispatch({
        type: "MESSAGE_UPDATE",
        message: {
            ...current,
            content: original,
            __telegramSelectionVisual: undefined
        },
        otherPluginBypass: true
    });
    visualOriginals.delete(key);
}

function setSelected(message, enabled) {
    const channelId = channelOf(message);
    if (!message?.id || !channelId) return;

    const normalized = { ...message, channel_id: channelId };

    if (!selectionChannelId) selectionChannelId = channelId;
    if (channelId !== selectionChannelId) {
        toast("Сначала закончи выбор в текущем чате");
        return;
    }

    const key = messageKey(normalized);

    if (enabled) {
        selected.set(key, cleanSnapshot(normalized));
        paintMessage(normalized, true);
    } else {
        selected.delete(key);
        paintMessage(normalized, false);
    }

    toast(`Выбрано: ${selected.size}`);
}

function toggleSelected(message) {
    const channelId = channelOf(message);
    if (!message?.id || !channelId) return;

    const key = `${channelId}:${message.id}`;
    setSelected(message, !selected.has(key));
}

function cancelSelection(showToast = true) {
    for (const message of selected.values()) {
        try { paintMessage(message, false); } catch (_) {}
    }

    selected.clear();
    visualOriginals.clear();
    selectionMode = false;
    selectionChannelId = null;

    try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}

    if (showToast) toast("Выбор отменён");
}

function beginSelection(message) {
    cancelSelection(false);

    selectionMode = true;
    selectionChannelId = channelOf(message);

    ensureTapHooks();
    setSelected(message, true);

    try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}
    toast("Режим выбора включён. Нажимай на другие сообщения");
}

function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.toArray === "function") return value.toArray();
    if (typeof value.values === "function") return Array.from(value.values());
    if (typeof value === "object") return Object.values(value);
    return [];
}

function formatTime(timestamp) {
    if (!timestamp) return "неизвестно";

    try {
        const d = new Date(timestamp);
        if (Number.isNaN(d.getTime())) return String(timestamp);

        const pad = n => String(n).padStart(2, "0");
        const local =
            `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
            `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

        return `${local} | ${d.toISOString()}`;
    } catch (_) {
        return String(timestamp);
    }
}

function authorInfo(message) {
    const author = message?.author ?? {};
    const username = author.username ?? author.name ?? "unknown";
    const globalName = author.global_name ?? author.globalName ?? author.displayName ?? null;
    const discriminator =
        author.discriminator && author.discriminator !== "0"
            ? `#${author.discriminator}`
            : "";

    return {
        display: globalName
            ? `${globalName} (@${username}${discriminator})`
            : `@${username}${discriminator}`,
        username,
        globalName,
        id: author.id ?? "unknown",
        bot: Boolean(author.bot),
        system: Boolean(author.system)
    };
}

function attachmentLines(message) {
    const attachments = toArray(message?.attachments);
    if (!attachments.length) return [];

    const lines = ["Вложения:"];

    attachments.forEach((attachment, index) => {
        const name = attachment?.filename ?? attachment?.name ?? "file";
        const url = attachment?.url ?? attachment?.proxy_url ?? attachment?.proxyURL ?? "";
        const type = attachment?.content_type ?? attachment?.contentType ?? "";
        const size = attachment?.size ?? "";
        const width = attachment?.width ?? "";
        const height = attachment?.height ?? "";

        lines.push(
            `${index + 1}. ${name}` +
            `${type ? ` | type=${type}` : ""}` +
            `${size !== "" ? ` | size=${size}` : ""}` +
            `${width && height ? ` | ${width}x${height}` : ""}` +
            `${url ? `\n${url}` : ""}`
        );
    });

    return lines;
}

function embedLines(message) {
    const embeds = toArray(message?.embeds);
    if (!embeds.length) return [];

    const lines = ["Embeds:"];

    embeds.forEach((embed, index) => {
        lines.push(
            `${index + 1}. ` +
            [
                embed?.type ? `type=${embed.type}` : null,
                embed?.title ? `title=${embed.title}` : null,
                embed?.description ? `description=${embed.description}` : null,
                embed?.url ? `url=${embed.url}` : null
            ].filter(Boolean).join(" | ")
        );
    });

    return lines;
}

function reactionLines(message) {
    const reactions = toArray(message?.reactions);
    if (!reactions.length) return [];

    return [
        "Реакции: " +
        reactions.map(reaction => {
            const emoji = reaction?.emoji?.name ?? reaction?.emoji?.id ?? "?";
            return `${emoji} x${reaction?.count ?? 0}`;
        }).join(", ")
    ];
}

function stickerLines(message) {
    const stickers = toArray(
        message?.sticker_items ??
        message?.stickerItems ??
        message?.stickers
    );

    return stickers.map(sticker =>
        `Стикер: ${sticker?.name ?? "unknown"} | ` +
        `id=${sticker?.id ?? "unknown"} | ` +
        `format=${sticker?.format_type ?? sticker?.formatType ?? "unknown"}`
    );
}

function replyLines(message) {
    const reference = message?.message_reference ?? message?.messageReference;
    const referenced = message?.referenced_message ?? message?.referencedMessage;

    if (!reference && !referenced) return [];

    const lines = [];

    if (reference) {
        lines.push(
            "Ответ на: " +
            `message_id=${reference.message_id ?? reference.messageId ?? "unknown"} | ` +
            `channel_id=${reference.channel_id ?? reference.channelId ?? "unknown"} | ` +
            `guild_id=${reference.guild_id ?? reference.guildId ?? "unknown"}`
        );
    }

    if (referenced) {
        const author = authorInfo(referenced);
        lines.push(`Цитируемый автор: ${author.display} | author_id=${author.id}`);

        if (referenced.content) {
            lines.push(`Цитируемый текст: ${referenced.content}`);
        }
    }

    return lines;
}

function messageToText(message) {
    const m = cleanSnapshot(message);
    const author = authorInfo(m);

    const timestamp = m?.timestamp ?? m?.created_at ?? m?.createdAt;
    const edited = m?.edited_timestamp ?? m?.editedTimestamp;

    const lines = [
        `Время: ${formatTime(timestamp)}`,
        `Автор: ${author.display}`,
        `username: ${author.username}`,
        `global_name: ${author.globalName ?? ""}`,
        `author_id: ${author.id}`,
        `message_id: ${m?.id ?? "unknown"}`,
        `channel_id: ${channelOf(m) ?? "unknown"}`,
        `guild_id: ${m?.guild_id ?? m?.guildId ?? "unknown"}`,
        `type: ${m?.type ?? "unknown"}`,
        `flags: ${m?.flags ?? 0}`,
        `bot: ${author.bot}`,
        `system: ${author.system}`
    ];

    if (edited) lines.push(`Изменено: ${formatTime(edited)}`);

    lines.push(...replyLines(m));

    const mentions = toArray(m?.mentions);
    if (mentions.length) {
        lines.push(
            "Упоминания: " +
            mentions.map(user =>
                `${user?.username ?? user?.global_name ?? "user"}(${user?.id ?? "?"})`
            ).join(", ")
        );
    }

    const roles = toArray(m?.mention_roles ?? m?.mentionRoles);
    if (roles.length) {
        lines.push(`Упомянутые роли: ${roles.join(", ")}`);
    }

    lines.push("Текст:");
    lines.push(
        typeof m?.content === "string" && m.content.length
            ? m.content
            : "(без текста)"
    );

    lines.push(...attachmentLines(m));
    lines.push(...embedLines(m));
    lines.push(...stickerLines(m));
    lines.push(...reactionLines(m));

    return lines.join("\n");
}

function sortMessages(messages) {
    return messages.sort((a, b) => {
        const at = Date.parse(a?.timestamp ?? "");
        const bt = Date.parse(b?.timestamp ?? "");

        if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) {
            return at - bt;
        }

        const ai = String(a?.id ?? "");
        const bi = String(b?.id ?? "");

        if (ai.length !== bi.length) return ai.length - bi.length;
        return ai.localeCompare(bi);
    });
}

function copySelected() {
    const messages = sortMessages(Array.from(selected.values()));

    if (!messages.length) {
        toast("Нет выбранных сообщений");
        return;
    }

    const text = messages
        .map(messageToText)
        .join("\n\n====================\n\n");

    clipboard.setString(text);

    const count = messages.length;
    cancelSelection(false);
    toast(`Скопировано сообщений: ${count}`);
}

function makeRow(label, onPress) {
    const props = { label, onPress };
    const icon = copyIcon();

    if (ActionSheetRow?.Icon && icon && React?.createElement) {
        props.icon = React.createElement(ActionSheetRow.Icon, { source: icon });
    }

    return React.createElement(ActionSheetRow, props);
}

function injectSelectionActions(buttons, message) {
    if (!Array.isArray(buttons)) return;
    if (buttons.some(row => row?.props?.__telegramSelectionRow)) return;

    const mark = row => {
        if (row?.props) row.props.__telegramSelectionRow = true;
        return row;
    };

    const rows = [];

    if (!selectionMode) {
        rows.push(
            mark(
                makeRow(
                    "Выбрать сообщение",
                    () => beginSelection(message)
                )
            )
        );
    } else {
        const isSelected = selected.has(messageKey(message));

        rows.push(
            mark(
                makeRow(
                    isSelected
                        ? "Убрать это сообщение из выбора"
                        : "Добавить это сообщение",
                    () => {
                        toggleSelected(message);
                        try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}
                    }
                )
            )
        );

        if (selected.size > 0) {
            rows.push(
                mark(
                    makeRow(
                        `Скопировать выбранные (${selected.size})`,
                        copySelected
                    )
                )
            );
        }

        rows.push(
            mark(
                makeRow(
                    "Отменить весь выбор",
                    () => cancelSelection(true)
                )
            )
        );
    }

    buttons.splice(0, 0, ...rows);
}

function processTapArgs(args) {
    if (!selectionMode) return;

    try {
        const payload = args?.[0];
        const nativeEvent = payload?.nativeEvent ?? payload;

        const channelId =
            nativeEvent?.channelId ??
            nativeEvent?.channel_id ??
            payload?.message?.channel_id ??
            payload?.message?.channelId ??
            selectionChannelId;

        const messageId =
            nativeEvent?.messageId ??
            nativeEvent?.message_id ??
            payload?.message?.id;

        if (!channelId || !messageId) return;

        const message = getMessage(channelId, messageId, payload?.message);
        if (!message) return;

        toggleSelected({
            ...message,
            channel_id: channelId
        });
    } catch (_) {}
}

function patchMessageTapHandlers(handlers) {
    if (!handlers || patchedHandlers.has(handlers)) return;
    if (typeof handlers.handleTapMessage !== "function") return;

    patchedHandlers.add(handlers);

    try {
        const unpatch = after(
            "handleTapMessage",
            handlers,
            args => processTapArgs(args)
        );

        handlerUnpatches.push(unpatch);
    } catch (_) {
        patchedHandlers.delete(handlers);
    }
}

function restoreTapHooks() {
    handlerUnpatches.forEach(unpatch => {
        try { unpatch(); } catch (_) {}
    });
    handlerUnpatches = [];

    getterRestorers.forEach(restore => {
        try { restore(); } catch (_) {}
    });
    getterRestorers = [];

    patchedHandlers.clear();
    hookedPrototype = null;
}

function ensureTapHooks() {
    try {
        const module = findByProps("MessagesHandlers");
        const MessagesHandlers = module?.MessagesHandlers;
        const prototype = MessagesHandlers?.prototype;

        if (!prototype) return false;
        if (hookedPrototype === prototype) return true;

        restoreTapHooks();
        hookedPrototype = prototype;

        patchMessageTapHandlers(prototype);

        const names = ["params", "handlers", "_params", "messageHandlers"];

        for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
            const originalGetter = descriptor?.get;

            if (!originalGetter) continue;

            Object.defineProperty(prototype, name, {
                ...descriptor,
                configurable: true,
                get() {
                    const value = originalGetter.call(this);

                    try { patchMessageTapHandlers(this); } catch (_) {}
                    try { patchMessageTapHandlers(value); } catch (_) {}

                    return value;
                }
            });

            getterRestorers.push(() => {
                try {
                    Object.defineProperty(prototype, name, descriptor);
                } catch (_) {}
            });
        }

        return true;
    } catch (_) {
        return false;
    }
}

function patchActionSheet() {
    if (!LazyActionSheet) return;

    const unpatch = before(
        "openLazy",
        LazyActionSheet,
        ([component, key, msg]) => {
            const message = msg?.message;

            if (
                key !== "MessageLongPressActionSheet" ||
                !message ||
                !component?.then
            ) {
                return;
            }

            component.then(instance => {
                const sheetUnpatch = after(
                    "default",
                    instance,
                    (_, result) => {
                        setTimeout(() => {
                            try { sheetUnpatch(); } catch (_) {}
                        }, 0);

                        const buttons = findInReactTree(
                            result,
                            node =>
                                Array.isArray(node) &&
                                node.some?.(
                                    item =>
                                        item?.type?.name === "ActionSheetRow" ||
                                        item?.props?.label
                                )
                        );

                        if (!buttons) return;

                        const channelId = channelOf(message);
                        const current = getMessage(
                            channelId,
                            message.id,
                            message
                        );

                        injectSelectionActions(buttons, current);
                    }
                );
            });
        }
    );

    actionSheetUnpatches.push(unpatch);
}

const pluginDefinition = {
    onLoad() {
        patchActionSheet();
        ensureTapHooks();
    },

    onUnload() {
        actionSheetUnpatches.forEach(unpatch => {
            try { unpatch(); } catch (_) {}
        });
        actionSheetUnpatches = [];

        restoreTapHooks();
        cancelSelection(false);
    }
};

exports.default = pluginDefinition;
Object.defineProperty(exports, "__esModule", { value: true });
return exports;

})(
    {},
    vendetta.metro,
    vendetta.metro.common,
    vendetta.patcher,
    vendetta.ui.assets,
    vendetta.ui.components,
    vendetta.ui.toasts,
    vendetta.utils
);
