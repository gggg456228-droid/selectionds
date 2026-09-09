(function(exports, metro, common, patcher, assets, components, toasts, utils) {
"use strict";

const { findByProps, findByStoreName } = metro;
const { clipboard, FluxDispatcher, React } = common;
const { after, before } = patcher;
const { getAssetIDByName } = assets;
const { Forms } = components;
const { showToast } = toasts;
const { findInReactTree } = utils;

const BUILD = "0.6.0";
const BLUE_MARKER = "🔵 ";

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow ?? Forms.FormRow;
const MessageStore = findByStoreName("MessageStore");
const NativeEventUtils = findByProps("getNativeSyntheticEventData");

const selected = new Map();
const originals = new Map();
const pendingTaps = new Map();
const recentTaps = new Map();
const suppressedLongPresses = new Map();

let selectionMode = false;
let selectionChannelId = null;
let actionSheetUnpatch = null;
let nativeEventUnpatch = null;

function icon() {
    try { return getAssetIDByName("ic_message_copy"); }
    catch (_) { return undefined; }
}

function toast(text) {
    try { showToast(text, icon()); }
    catch (_) {
        try { showToast(text); } catch (_) {}
    }
}

function channelOf(message) {
    return message?.channel_id ?? message?.channelId ?? null;
}

function keyOf(message) {
    return `${channelOf(message)}:${message?.id}`;
}

function getMessage(channelId, messageId, fallback) {
    try {
        return MessageStore?.getMessage?.(channelId, messageId) ?? fallback ?? null;
    } catch (_) {
        return fallback ?? null;
    }
}

function cleanMessage(message) {
    const channelId = channelOf(message);
    const key = `${channelId}:${message?.id}`;
    let content = originals.get(key) ?? message?.content ?? "";

    if (typeof content === "string" && content.startsWith(BLUE_MARKER)) {
        content = content.slice(BLUE_MARKER.length);
    }

    return {
        ...message,
        channel_id: channelId,
        content
    };
}

function paint(message, enabled) {
    const channelId = channelOf(message);
    if (!message?.id || !channelId || !FluxDispatcher?.dispatch) return;

    const key = `${channelId}:${message.id}`;
    const current = getMessage(channelId, message.id, message) ?? message;

    if (enabled) {
        if (!originals.has(key)) {
            let content = typeof current.content === "string" ? current.content : "";
            if (content.startsWith(BLUE_MARKER)) {
                content = content.slice(BLUE_MARKER.length);
            }
            originals.set(key, content);
        }

        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: {
                ...current,
                content: BLUE_MARKER + (originals.get(key) ?? ""),
                __telegramSelectionVisual: true
            },
            otherPluginBypass: true
        });

        return;
    }

    if (!originals.has(key)) return;

    FluxDispatcher.dispatch({
        type: "MESSAGE_UPDATE",
        message: {
            ...current,
            content: originals.get(key) ?? "",
            __telegramSelectionVisual: undefined
        },
        otherPluginBypass: true
    });

    originals.delete(key);
}

function setSelected(message, enabled, showToast = true) {
    const channelId = channelOf(message);
    if (!message?.id || !channelId) return;

    if (!selectionChannelId) selectionChannelId = channelId;

    if (channelId !== selectionChannelId) {
        toast("Выбор работает только в текущем чате");
        return;
    }

    const normalized = {
        ...message,
        channel_id: channelId
    };

    const key = keyOf(normalized);

    if (enabled) {
        selected.set(key, cleanMessage(normalized));
        paint(normalized, true);
    } else {
        selected.delete(key);
        paint(normalized, false);
    }

    if (showToast) toast(`Выбрано: ${selected.size}`);
}

function toggleSelected(message) {
    const key = keyOf(message);
    setSelected(message, !selected.has(key), true);
}

function clearPending() {
    for (const timer of pendingTaps.values()) {
        try { clearTimeout(timer); } catch (_) {}
    }

    pendingTaps.clear();
    recentTaps.clear();
    suppressedLongPresses.clear();
}

function cancelSelection(show = true) {
    clearPending();

    for (const message of selected.values()) {
        try { paint(message, false); } catch (_) {}
    }

    selected.clear();
    originals.clear();
    selectionMode = false;
    selectionChannelId = null;

    try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}

    if (show) toast("Выбор отменён");
}

function beginSelection(message) {
    cancelSelection(false);

    const channelId = channelOf(message);
    if (!message?.id || !channelId) return;

    selectionMode = true;
    selectionChannelId = channelId;

    setSelected({
        ...message,
        channel_id: channelId
    }, true, false);

    try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}
    toast(`Выбрано: 1 | v${BUILD}`);
}

function dataFromNativeResult(result, fallbackPayload) {
    const candidates = [];

    if (result && typeof result === "object") candidates.push(result);

    try {
        if (fallbackPayload?.nativeEvent) candidates.push(fallbackPayload.nativeEvent);
    } catch (_) {}

    if (fallbackPayload && typeof fallbackPayload === "object") candidates.push(fallbackPayload);

    for (const data of candidates) {
        const messageId =
            data?.messageId ??
            data?.message_id ??
            data?.id ??
            data?.message?.id;

        const channelId =
            data?.channelId ??
            data?.channel_id ??
            data?.message?.channel_id ??
            data?.message?.channelId ??
            selectionChannelId;

        if (messageId && channelId) {
            return {
                messageId: String(messageId),
                channelId: String(channelId),
                fallback: data?.message
            };
        }
    }

    return null;
}

function isSuppressed(key) {
    const at = suppressedLongPresses.get(key);
    if (!at) return false;

    if (Date.now() - at > 900) {
        suppressedLongPresses.delete(key);
        return false;
    }

    return true;
}

function scheduleMessageTap(info) {
    if (!selectionMode || !info?.messageId || !info?.channelId) return;

    const key = `${info.channelId}:${info.messageId}`;
    const now = Date.now();

    if (isSuppressed(key)) return;

    const recent = recentTaps.get(key);
    if (recent && now - recent < 300) return;

    if (pendingTaps.has(key)) return;

    const timer = setTimeout(() => {
        pendingTaps.delete(key);

        if (!selectionMode || isSuppressed(key)) return;

        const last = recentTaps.get(key);
        const current = Date.now();
        if (last && current - last < 300) return;

        const message = getMessage(info.channelId, info.messageId, info.fallback);
        if (!message) return;

        recentTaps.set(key, current);

        toggleSelected({
            ...message,
            channel_id: info.channelId
        });
    }, 45);

    pendingTaps.set(key, timer);
}

function suppressLongPress(message) {
    if (!selectionMode) return;

    const channelId = channelOf(message) ?? selectionChannelId;
    const messageId = message?.id;
    if (!channelId || !messageId) return;

    const key = `${channelId}:${messageId}`;
    suppressedLongPresses.set(key, Date.now());

    const timer = pendingTaps.get(key);
    if (timer) {
        try { clearTimeout(timer); } catch (_) {}
        pendingTaps.delete(key);
    }

    setTimeout(() => {
        const at = suppressedLongPresses.get(key);
        if (at && Date.now() - at >= 850) {
            suppressedLongPresses.delete(key);
        }
    }, 950);
}

function patchNativeEventDecoder() {
    if (!NativeEventUtils?.getNativeSyntheticEventData || nativeEventUnpatch) return;

    try {
        nativeEventUnpatch = after(
            "getNativeSyntheticEventData",
            NativeEventUtils,
            (args, result) => {
                if (!selectionMode) return;

                try {
                    const info = dataFromNativeResult(result, args?.[0]);
                    if (info) scheduleMessageTap(info);
                } catch (_) {}
            }
        );
    } catch (_) {
        nativeEventUnpatch = null;
    }
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

        const p = n => String(n).padStart(2, "0");

        return (
            `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ` +
            `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} | ` +
            d.toISOString()
        );
    } catch (_) {
        return String(timestamp);
    }
}

function authorInfo(message) {
    const a = message?.author ?? {};
    const username = a.username ?? a.name ?? "unknown";
    const globalName = a.global_name ?? a.globalName ?? a.displayName ?? "";
    const discriminator =
        a.discriminator && a.discriminator !== "0"
            ? `#${a.discriminator}`
            : "";

    return {
        display: globalName
            ? `${globalName} (@${username}${discriminator})`
            : `@${username}${discriminator}`,
        username,
        globalName,
        id: a.id ?? "unknown",
        bot: Boolean(a.bot),
        system: Boolean(a.system)
    };
}

function attachmentLines(message) {
    const list = toArray(message?.attachments);
    if (!list.length) return [];

    const lines = ["Вложения:"];

    list.forEach((a, i) => {
        const url = a?.url ?? a?.proxy_url ?? a?.proxyURL ?? "";

        lines.push(
            `${i + 1}. ${a?.filename ?? a?.name ?? "file"}` +
            `${a?.content_type ?? a?.contentType ? ` | type=${a.content_type ?? a.contentType}` : ""}` +
            `${a?.size != null ? ` | size=${a.size}` : ""}` +
            `${a?.width && a?.height ? ` | ${a.width}x${a.height}` : ""}` +
            `${url ? `\n${url}` : ""}`
        );
    });

    return lines;
}

function replyLines(message) {
    const ref = message?.message_reference ?? message?.messageReference;
    const quoted = message?.referenced_message ?? message?.referencedMessage;
    const lines = [];

    if (ref) {
        lines.push(
            `Ответ на: message_id=${ref.message_id ?? ref.messageId ?? "unknown"} | ` +
            `channel_id=${ref.channel_id ?? ref.channelId ?? "unknown"} | ` +
            `guild_id=${ref.guild_id ?? ref.guildId ?? "unknown"}`
        );
    }

    if (quoted) {
        const a = authorInfo(quoted);
        lines.push(`Цитируемый автор: ${a.display} | author_id=${a.id}`);

        if (quoted.content) {
            lines.push(`Цитируемый текст: ${quoted.content}`);
        }
    }

    return lines;
}

function messageToText(message) {
    const m = cleanMessage(message);
    const a = authorInfo(m);
    const timestamp = m?.timestamp ?? m?.created_at ?? m?.createdAt;
    const edited = m?.edited_timestamp ?? m?.editedTimestamp;

    const lines = [
        `Время: ${formatTime(timestamp)}`,
        `Автор: ${a.display}`,
        `username: ${a.username}`,
        `global_name: ${a.globalName}`,
        `author_id: ${a.id}`,
        `message_id: ${m?.id ?? "unknown"}`,
        `channel_id: ${channelOf(m) ?? "unknown"}`,
        `guild_id: ${m?.guild_id ?? m?.guildId ?? "unknown"}`,
        `type: ${m?.type ?? "unknown"}`,
        `flags: ${m?.flags ?? 0}`,
        `bot: ${a.bot}`,
        `system: ${a.system}`
    ];

    if (edited) lines.push(`Изменено: ${formatTime(edited)}`);

    lines.push(...replyLines(m));

    const mentions = toArray(m?.mentions);
    if (mentions.length) {
        lines.push(
            `Упоминания: ${mentions.map(u =>
                `${u?.username ?? u?.global_name ?? "user"}(${u?.id ?? "?"})`
            ).join(", ")}`
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

    const embeds = toArray(m?.embeds);
    embeds.forEach((e, i) => {
        lines.push(
            `Embed ${i + 1}: ` +
            [
                e?.type ? `type=${e.type}` : null,
                e?.title ? `title=${e.title}` : null,
                e?.description ? `description=${e.description}` : null,
                e?.url ? `url=${e.url}` : null
            ].filter(Boolean).join(" | ")
        );
    });

    const stickers = toArray(m?.sticker_items ?? m?.stickerItems ?? m?.stickers);
    stickers.forEach(s => {
        lines.push(
            `Стикер: ${s?.name ?? "unknown"} | ` +
            `id=${s?.id ?? "unknown"} | ` +
            `format=${s?.format_type ?? s?.formatType ?? "unknown"}`
        );
    });

    const reactions = toArray(m?.reactions);
    if (reactions.length) {
        lines.push(
            `Реакции: ${reactions.map(r =>
                `${r?.emoji?.name ?? r?.emoji?.id ?? "?"} x${r?.count ?? 0}`
            ).join(", ")}`
        );
    }

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

    clipboard.setString(
        messages
            .map(messageToText)
            .join("\n\n====================\n\n")
    );

    const count = messages.length;
    cancelSelection(false);
    toast(`Скопировано сообщений: ${count}`);
}

function makeRow(label, onPress) {
    const props = {
        label,
        onPress
    };

    const source = icon();

    if (ActionSheetRow?.Icon && source && React?.createElement) {
        props.icon = React.createElement(
            ActionSheetRow.Icon,
            { source }
        );
    }

    return React.createElement(ActionSheetRow, props);
}

function injectRows(buttons, message) {
    if (!Array.isArray(buttons)) return;

    if (
        buttons.some(
            row => row?.props?.__telegramSelectionRow
        )
    ) {
        return;
    }

    const mark = row => {
        if (row?.props) {
            row.props.__telegramSelectionRow = true;
        }
        return row;
    };

    const rows = [];

    if (!selectionMode) {
        rows.push(
            mark(
                makeRow(
                    `Выбрать сообщение [v${BUILD}]`,
                    () => beginSelection(message)
                )
            )
        );
    } else {
        const isSelected = selected.has(keyOf(message));

        rows.push(
            mark(
                makeRow(
                    isSelected
                        ? "Убрать это сообщение из выбора"
                        : "Добавить это сообщение",
                    () => {
                        setSelected(message, !isSelected, true);
                        try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}
                    }
                )
            )
        );

        if (selected.size) {
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

function patchActionSheet() {
    if (!LazyActionSheet || actionSheetUnpatch) return;

    actionSheetUnpatch = before(
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

            suppressLongPress(message);

            component.then(instance => {
                const unpatch = after(
                    "default",
                    instance,
                    (_, result) => {
                        setTimeout(() => {
                            try { unpatch(); } catch (_) {}
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

                        injectRows(buttons, current);
                    }
                );
            });
        }
    );
}

const pluginDefinition = {
    onLoad() {
        patchNativeEventDecoder();
        patchActionSheet();
    },

    onUnload() {
        try { nativeEventUnpatch?.(); } catch (_) {}
        nativeEventUnpatch = null;

        try { actionSheetUnpatch?.(); } catch (_) {}
        actionSheetUnpatch = null;

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
