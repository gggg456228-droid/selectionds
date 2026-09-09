(function(exports, metro, common, patcher, assets, components, toasts, utils) {
"use strict";
const { findByProps, findByStoreName } = metro;
const { clipboard, FluxDispatcher } = common;
const { after, before, instead } = patcher;
const { getAssetIDByName } = assets;
const { Forms } = components;
const { showToast } = toasts;
const { findInReactTree } = utils;

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow ?? Forms.FormRow;
const MessageStore = findByStoreName("MessageStore");
const HandlersModule = findByProps("MessagesHandlers");
const MessagesHandlers = HandlersModule?.MessagesHandlers;

const selected = new Map();
const visualOriginals = new Map();
const BLUE_MARKER = "🔵 ";
let selectionMode = false;
let selectionChannelId = null;
let patches = [];
let handlerPatches = [];
const patchedHandlers = new Set();
let unpatchGetter = null;

const copyIcon = () => getAssetIDByName("ic_message_copy");

function toast(text) {
    try {
        showToast(text, copyIcon());
    } catch (_) {
        showToast(text);
    }
}

function getMessage(channelId, messageId, fallback) {
    return MessageStore?.getMessage?.(channelId, messageId) ?? fallback ?? null;
}

function messageKey(message) {
    return `${message.channel_id ?? message.channelId}:${message.id}`;
}

function paintMessage(message, value) {
    const channelId = message?.channel_id ?? message?.channelId;
    if (!message?.id || !channelId || !FluxDispatcher?.dispatch) return;

    const normalized = { ...message, channel_id: channelId };
    const key = messageKey(normalized);
    const current = getMessage(channelId, message.id, normalized) ?? normalized;

    if (value) {
        if (!visualOriginals.has(key)) {
            visualOriginals.set(key, typeof current.content === "string" ? current.content : "");
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
    } else if (visualOriginals.has(key)) {
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
}

function cleanSnapshot(message) {
    const channelId = message?.channel_id ?? message?.channelId;
    const key = `${channelId}:${message?.id}`;
    return {
        ...message,
        channel_id: channelId,
        content: visualOriginals.get(key) ?? message?.content
    };
}

function setSelected(message, value) {
    const channelId = message?.channel_id ?? message?.channelId;
    if (!message?.id || !channelId) return;

    const normalized = { ...message, channel_id: channelId };

    if (!selectionChannelId) selectionChannelId = channelId;
    if (channelId !== selectionChannelId) {
        toast("Сначала закончи выбор в текущем чате");
        return;
    }

    const key = messageKey(normalized);
    if (value) {
        selected.set(key, cleanSnapshot(normalized));
        paintMessage(normalized, true);
    } else {
        selected.delete(key);
        paintMessage(normalized, false);
    }

    toast(`Выбрано: ${selected.size}`);
}

function toggleSelected(message) {
    const channelId = message?.channel_id ?? message?.channelId;
    if (!message?.id || !channelId) return;
    const key = `${channelId}:${message.id}`;
    setSelected(message, !selected.has(key));
}

function beginSelection(message) {
    cancelSelection(false);
    selectionMode = true;
    selectionChannelId = message?.channel_id ?? message?.channelId;
    setSelected(message, true);
    LazyActionSheet?.hideActionSheet?.();
    toast("Режим выбора включён. Теперь просто нажимай на другие сообщения");
}

function cancelSelection(show = true) {
    for (const message of selected.values()) {
        try { paintMessage(message, false); } catch (_) {}
    }
    selected.clear();
    visualOriginals.clear();
    selectionMode = false;
    selectionChannelId = null;
    LazyActionSheet?.hideActionSheet?.();
    if (show) toast("Выбор отменён");
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
    const a = message?.author ?? {};
    const username = a.username ?? a.name ?? "unknown";
    const globalName = a.global_name ?? a.globalName ?? a.displayName ?? null;
    const discriminator = a.discriminator && a.discriminator !== "0" ? `#${a.discriminator}` : "";
    const display = globalName ? `${globalName} (@${username}${discriminator})` : `@${username}${discriminator}`;
    return {
        display,
        id: a.id ?? "unknown",
        bot: Boolean(a.bot),
        system: Boolean(a.system)
    };
}

function attachmentLines(message) {
    const list = toArray(message?.attachments);
    if (!list.length) return [];
    const lines = ["Вложения:"];
    for (const a of list) {
        const name = a?.filename ?? a?.name ?? "file";
        const url = a?.url ?? a?.proxy_url ?? a?.proxyURL ?? "";
        const type = a?.content_type ?? a?.contentType ?? "";
        const size = a?.size != null ? `${a.size} bytes` : "";
        const dims = a?.width && a?.height ? `${a.width}x${a.height}` : "";
        const meta = [type, size, dims].filter(Boolean).join(", ");
        lines.push(`  ${name}${meta ? ` (${meta})` : ""}${url ? `\n  ${url}` : ""}`);
    }
    return lines;
}

function embedLines(message) {
    const embeds = toArray(message?.embeds);
    if (!embeds.length) return [];
    const lines = ["Embeds:"];
    embeds.forEach((e, i) => {
        const bits = [
            e?.type ? `type=${e.type}` : null,
            e?.title ? `title=${e.title}` : null,
            e?.description ? `description=${e.description}` : null,
            e?.url ? `url=${e.url}` : null
        ].filter(Boolean);
        lines.push(`  ${i + 1}. ${bits.join(" | ") || "embed"}`);
    });
    return lines;
}

function reactionLines(message) {
    const reactions = toArray(message?.reactions);
    if (!reactions.length) return [];
    const parts = reactions.map(r => {
        const emoji = r?.emoji?.name ?? r?.emoji?.id ?? "?";
        const count = r?.count ?? 0;
        return `${emoji} x${count}`;
    });
    return [`Реакции: ${parts.join(", ")}`];
}

function stickerLines(message) {
    const stickers = toArray(message?.sticker_items ?? message?.stickerItems ?? message?.stickers);
    if (!stickers.length) return [];
    return stickers.map(s => `Стикер: ${s?.name ?? "unknown"} | id=${s?.id ?? "unknown"} | format=${s?.format_type ?? s?.formatType ?? "unknown"}`);
}

function replyLines(message) {
    const ref = message?.message_reference ?? message?.messageReference;
    const referenced = message?.referenced_message ?? message?.referencedMessage;
    if (!ref && !referenced) return [];

    const lines = [];
    if (ref) {
        lines.push(
            `Ответ на: message_id=${ref.message_id ?? ref.messageId ?? "unknown"} | ` +
            `channel_id=${ref.channel_id ?? ref.channelId ?? "unknown"} | ` +
            `guild_id=${ref.guild_id ?? ref.guildId ?? "unknown"}`
        );
    }

    if (referenced) {
        const a = authorInfo(referenced);
        lines.push(`Цитируемый автор: ${a.display} | author_id=${a.id}`);
        if (referenced.content) lines.push(`Цитируемый текст: ${referenced.content}`);
    }
    return lines;
}

function messageToText(message) {
    const m = cleanSnapshot(message);
    const author = authorInfo(m);
    const channelId = m?.channel_id ?? m?.channelId ?? "unknown";
    const guildId = m?.guild_id ?? m?.guildId ?? "unknown";
    const timestamp = m?.timestamp ?? m?.created_at ?? m?.createdAt;
    const edited = m?.edited_timestamp ?? m?.editedTimestamp;
    const type = m?.type ?? "unknown";
    const flags = m?.flags ?? 0;

    const lines = [
        `Время: ${formatTime(timestamp)}`,
        `Автор: ${author.display}`,
        `author_id: ${author.id}`,
        `message_id: ${m?.id ?? "unknown"}`,
        `channel_id: ${channelId}`,
        `guild_id: ${guildId}`,
        `type: ${type}`,
        `flags: ${flags}`,
        `bot: ${author.bot}`,
        `system: ${author.system}`
    ];

    if (edited) lines.push(`Изменено: ${formatTime(edited)}`);
    lines.push(...replyLines(m));

    const mentions = toArray(m?.mentions);
    if (mentions.length) {
        lines.push(`Упоминания: ${mentions.map(u => `${u?.username ?? u?.global_name ?? "user"}(${u?.id ?? "?"})`).join(", ")}`);
    }

    const roleMentions = toArray(m?.mention_roles ?? m?.mentionRoles);
    if (roleMentions.length) lines.push(`Упомянутые роли: ${roleMentions.join(", ")}`);

    lines.push("Текст:");
    lines.push(typeof m?.content === "string" && m.content.length ? m.content : "(без текста)");
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
        if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;

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
    const iconSource = copyIcon();
    const props = { label, onPress };

    if (ActionSheetRow?.Icon && iconSource) {
        props.icon = React.createElement(ActionSheetRow.Icon, { source: iconSource });
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
        rows.push(mark(makeRow("Выбрать сообщение", () => beginSelection(message))));
    } else {
        const key = messageKey(message);
        const isSelected = selected.has(key);

        rows.push(mark(makeRow(
            isSelected ? "Убрать это сообщение из выбора" : "Добавить это сообщение",
            () => {
                toggleSelected(message);
                LazyActionSheet?.hideActionSheet?.();
            }
        )));

        if (selected.size > 0) {
            rows.push(mark(makeRow(`Скопировать выбранные (${selected.size})`, copySelected)));
        }

        rows.push(mark(makeRow("Отменить весь выбор", () => cancelSelection(true))));
    }

    buttons.splice(0, 0, ...rows);
}

function patchMessageTapHandlers(handlers) {
    if (!handlers || handlers.__telegramSelectionPatched) return;
    handlers.__telegramSelectionPatched = true;
    patchedHandlers.add(handlers);

    if (typeof handlers.handleTapMessage === "function") {
        const unpatch = instead("handleTapMessage", handlers, (args, original) => {
            if (!selectionMode) return original.apply(handlers, args);

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

                if (!channelId || !messageId) {
                    return original.apply(handlers, args);
                }

                const message = getMessage(channelId, messageId, payload?.message);
                if (!message) {
                    return original.apply(handlers, args);
                }

                toggleSelected({ ...message, channel_id: channelId });
                return;
            } catch (_) {
                return original.apply(handlers, args);
            }
        });
        handlerPatches.push(unpatch);
    }
}

const pluginDefinition = {
    onLoad() {
        patches.push(before("openLazy", LazyActionSheet, ([component, key, msg]) => {
            const message = msg?.message;
            if (key !== "MessageLongPressActionSheet" || !message || !component?.then) return;

            component.then(instance => {
                const unpatch = after("default", instance, (_, res) => {
                    setTimeout(unpatch, 0);

                    const buttons = findInReactTree(
                        res,
                        node => Array.isArray(node) && node.some?.(x => x?.type?.name === "ActionSheetRow" || x?.props?.label)
                    );

                    if (!buttons) return;
                    const current = getMessage(message.channel_id ?? message.channelId, message.id, message);
                    injectSelectionActions(buttons, current);
                });
            });
        }));

        if (MessagesHandlers?.prototype) {
            const descriptor = Object.getOwnPropertyDescriptor(MessagesHandlers.prototype, "params");
            const originalGetter = descriptor?.get;

            if (originalGetter) {
                Object.defineProperty(MessagesHandlers.prototype, "params", {
                    configurable: true,
                    get() {
                        patchMessageTapHandlers(this);
                        return originalGetter.call(this);
                    }
                });

                unpatchGetter = () => {
                    try {
                        Object.defineProperty(MessagesHandlers.prototype, "params", {
                            ...descriptor,
                            get: originalGetter
                        });
                    } catch (_) {}
                };
            }
        }
    },

    onUnload() {
        patches.forEach(fn => {
            try { fn(); } catch (_) {}
        });
        patches = [];

        handlerPatches.forEach(fn => {
            try { fn(); } catch (_) {}
        });
        handlerPatches = [];

        if (unpatchGetter) {
            try { unpatchGetter(); } catch (_) {}
            unpatchGetter = null;
        }

        patchedHandlers.forEach(handlers => {
            try { delete handlers.__telegramSelectionPatched; } catch (_) {}
        });
        patchedHandlers.clear();

        cancelSelection(false);
    }
};

exports.default = pluginDefinition;
Object.defineProperty(exports, "__esModule", { value: true });
return exports;
})({}, vendetta.metro, vendetta.metro.common, vendetta.patcher, vendetta.ui.assets, vendetta.ui.components, vendetta.ui.toasts, vendetta.utils);
