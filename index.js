(function(exports, metro, common, patcher, assets, components, toasts, utils) {
"use strict";

const { findByProps, findByStoreName } = metro;
const { clipboard, FluxDispatcher, React } = common;
const { after, before } = patcher;
const { getAssetIDByName } = assets;
const { Forms } = components;
const { showToast } = toasts;
const { findInReactTree } = utils;

const BUILD = "0.5.0";
const BLUE_MARKER = "🔵 ";

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow ?? Forms.FormRow;
const MessageStore = findByStoreName("MessageStore");
const NativeEventUtils = findByProps("getNativeSyntheticEventData");

const selected = new Map();
const originals = new Map();
const patchedTargets = new Set();
const getterRestorers = [];

let actionSheetUnpatch = null;
let selectionMode = false;
let selectionChannelId = null;
let lastTapKey = "";
let lastTapAt = 0;
let tapPatchCount = 0;

function icon() {
    try { return getAssetIDByName("ic_message_copy"); } catch (_) { return undefined; }
}

function toast(text) {
    try { showToast(text, icon()); }
    catch (_) { try { showToast(text); } catch (_) {} }
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
    const original = originals.get(key);
    let content = original ?? message?.content ?? "";
    if (typeof content === "string" && content.startsWith(BLUE_MARKER)) {
        content = content.slice(BLUE_MARKER.length);
    }
    return { ...message, channel_id: channelId, content };
}

function paint(message, enabled) {
    const channelId = channelOf(message);
    if (!message?.id || !channelId || !FluxDispatcher?.dispatch) return;

    const key = `${channelId}:${message.id}`;
    const current = getMessage(channelId, message.id, message) ?? message;

    if (enabled) {
        if (!originals.has(key)) {
            let content = typeof current.content === "string" ? current.content : "";
            if (content.startsWith(BLUE_MARKER)) content = content.slice(BLUE_MARKER.length);
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
    } else if (originals.has(key)) {
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
}

function setSelected(message, enabled) {
    const channelId = channelOf(message);
    if (!message?.id || !channelId) return;

    if (!selectionChannelId) selectionChannelId = channelId;
    if (channelId !== selectionChannelId) {
        toast("Выбор работает только в текущем чате");
        return;
    }

    const normalized = { ...message, channel_id: channelId };
    const key = keyOf(normalized);

    if (enabled) {
        selected.set(key, cleanMessage(normalized));
        paint(normalized, true);
    } else {
        selected.delete(key);
        paint(normalized, false);
    }

    toast(`Выбрано: ${selected.size}`);
}

function toggleSelected(message) {
    const key = keyOf(message);
    setSelected(message, !selected.has(key));
}

function cancelSelection(show = true) {
    for (const message of selected.values()) {
        try { paint(message, false); } catch (_) {}
    }

    selected.clear();
    originals.clear();
    selectionMode = false;
    selectionChannelId = null;
    lastTapKey = "";
    lastTapAt = 0;

    try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}
    if (show) toast("Выбор отменён");
}

function decodeTap(args) {
    const payload = args?.[0];
    const candidates = [];

    try {
        const decoded = NativeEventUtils?.getNativeSyntheticEventData?.(payload);
        if (decoded) candidates.push(decoded);
    } catch (_) {}

    try {
        if (payload?.nativeEvent) candidates.push(payload.nativeEvent);
    } catch (_) {}

    if (payload) candidates.push(payload);

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
            return { messageId: String(messageId), channelId: String(channelId), fallback: data?.message };
        }
    }

    return null;
}

function onMessageTap(args) {
    if (!selectionMode) return;

    const info = decodeTap(args);
    if (!info) return;

    const dedupeKey = `${info.channelId}:${info.messageId}`;
    const now = Date.now();
    if (dedupeKey === lastTapKey && now - lastTapAt < 120) return;
    lastTapKey = dedupeKey;
    lastTapAt = now;

    const message = getMessage(info.channelId, info.messageId, info.fallback);
    if (!message) {
        toast(`Не нашёл сообщение ${info.messageId}`);
        return;
    }

    toggleSelected({ ...message, channel_id: info.channelId });
}

function patchTapTarget(target) {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return false;
    if (patchedTargets.has(target)) return true;
    if (typeof target.handleTapMessage !== "function") return false;

    try {
        const unpatch = after("handleTapMessage", target, args => onMessageTap(args));
        patchedTargets.add(target);
        tapPatchCount++;
        target.__telegramSelectionUnpatch = unpatch;
        return true;
    } catch (_) {
        return false;
    }
}

function scanTarget(target, depth = 1) {
    if (!target || depth < 0) return;
    patchTapTarget(target);

    if (depth === 0 || (typeof target !== "object" && typeof target !== "function")) return;

    const keys = ["default", "handlers", "params", "_params", "messageHandlers", "MessagesHandlers"];
    for (const key of keys) {
        try {
            const value = target[key];
            if (value && value !== target) scanTarget(value, depth - 1);
        } catch (_) {}
    }
}

function hookGetter(prototype, name) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(prototype, name); } catch (_) { return; }
    if (!descriptor?.get || descriptor.configurable === false) return;
    if (descriptor.get.__telegramSelectionWrapped) return;

    const originalGetter = descriptor.get;

    function wrappedGetter() {
        const value = originalGetter.call(this);
        try { scanTarget(this, 1); } catch (_) {}
        try { scanTarget(value, 2); } catch (_) {}
        return value;
    }
    wrappedGetter.__telegramSelectionWrapped = true;

    try {
        Object.defineProperty(prototype, name, {
            ...descriptor,
            get: wrappedGetter
        });

        getterRestorers.push(() => {
            try { Object.defineProperty(prototype, name, descriptor); } catch (_) {}
        });
    } catch (_) {}
}

function ensureTapHooks() {
    try {
        scanTarget(findByProps("handleTapMessage"), 2);
    } catch (_) {}

    try {
        const module = findByProps("MessagesHandlers");
        scanTarget(module, 2);

        const MessagesHandlers = module?.MessagesHandlers;
        const prototype = MessagesHandlers?.prototype;

        if (prototype) {
            scanTarget(prototype, 1);
            for (const name of ["params", "handlers", "_params", "messageHandlers"]) {
                hookGetter(prototype, name);
            }
        }
    } catch (_) {}

    return tapPatchCount;
}

function beginSelection(message) {
    cancelSelection(false);
    selectionMode = true;
    selectionChannelId = channelOf(message);

    const count = ensureTapHooks();
    setSelected(message, true);

    try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}
    toast(`Выбор включён. Tap hooks: ${count}`);
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
        return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} | ${d.toISOString()}`;
    } catch (_) {
        return String(timestamp);
    }
}

function authorInfo(message) {
    const a = message?.author ?? {};
    const username = a.username ?? a.name ?? "unknown";
    const globalName = a.global_name ?? a.globalName ?? a.displayName ?? "";
    const discriminator = a.discriminator && a.discriminator !== "0" ? `#${a.discriminator}` : "";
    return {
        display: globalName ? `${globalName} (@${username}${discriminator})` : `@${username}${discriminator}`,
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
        if (quoted.content) lines.push(`Цитируемый текст: ${quoted.content}`);
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
        lines.push(`Упоминания: ${mentions.map(u => `${u?.username ?? u?.global_name ?? "user"}(${u?.id ?? "?"})`).join(", ")}`);
    }

    lines.push("Текст:");
    lines.push(typeof m?.content === "string" && m.content.length ? m.content : "(без текста)");
    lines.push(...attachmentLines(m));

    const stickers = toArray(m?.sticker_items ?? m?.stickerItems ?? m?.stickers);
    stickers.forEach(s => lines.push(`Стикер: ${s?.name ?? "unknown"} | id=${s?.id ?? "unknown"}`));

    const reactions = toArray(m?.reactions);
    if (reactions.length) {
        lines.push(`Реакции: ${reactions.map(r => `${r?.emoji?.name ?? r?.emoji?.id ?? "?"} x${r?.count ?? 0}`).join(", ")}`);
    }

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

    clipboard.setString(messages.map(messageToText).join("\n\n====================\n\n"));
    const count = messages.length;
    cancelSelection(false);
    toast(`Скопировано сообщений: ${count}`);
}

function makeRow(label, onPress) {
    const props = { label, onPress };
    const source = icon();

    if (ActionSheetRow?.Icon && source && React?.createElement) {
        props.icon = React.createElement(ActionSheetRow.Icon, { source });
    }

    return React.createElement(ActionSheetRow, props);
}

function injectRows(buttons, message) {
    if (!Array.isArray(buttons)) return;
    if (buttons.some(row => row?.props?.__telegramSelectionRow)) return;

    const mark = row => {
        if (row?.props) row.props.__telegramSelectionRow = true;
        return row;
    };

    const rows = [];

    if (!selectionMode) {
        rows.push(mark(makeRow(`Выбрать сообщение [v${BUILD}]`, () => beginSelection(message))));
    } else {
        const isSelected = selected.has(keyOf(message));

        rows.push(mark(makeRow(
            isSelected ? "Убрать это сообщение из выбора" : "Добавить это сообщение",
            () => {
                toggleSelected(message);
                try { LazyActionSheet?.hideActionSheet?.(); } catch (_) {}
            }
        )));

        if (selected.size) {
            rows.push(mark(makeRow(`Скопировать выбранные (${selected.size})`, copySelected)));
        }

        rows.push(mark(makeRow("Отменить весь выбор", () => cancelSelection(true))));
    }

    buttons.splice(0, 0, ...rows);
}

function patchActionSheet() {
    if (!LazyActionSheet) return;

    actionSheetUnpatch = before("openLazy", LazyActionSheet, ([component, key, msg]) => {
        const message = msg?.message;
        if (key !== "MessageLongPressActionSheet" || !message || !component?.then) return;

        component.then(instance => {
            const unpatch = after("default", instance, (_, result) => {
                setTimeout(() => { try { unpatch(); } catch (_) {} }, 0);

                const buttons = findInReactTree(
                    result,
                    node => Array.isArray(node) && node.some?.(
                        item => item?.type?.name === "ActionSheetRow" || item?.props?.label
                    )
                );

                if (!buttons) return;

                const channelId = channelOf(message);
                injectRows(buttons, getMessage(channelId, message.id, message));
            });
        });
    });
}

function cleanupTapHooks() {
    for (const target of patchedTargets) {
        try { target.__telegramSelectionUnpatch?.(); } catch (_) {}
        try { delete target.__telegramSelectionUnpatch; } catch (_) {}
    }
    patchedTargets.clear();

    while (getterRestorers.length) {
        try { getterRestorers.pop()?.(); } catch (_) {}
    }

    tapPatchCount = 0;
}

const pluginDefinition = {
    onLoad() {
        patchActionSheet();
        ensureTapHooks();
    },

    onUnload() {
        try { actionSheetUnpatch?.(); } catch (_) {}
        actionSheetUnpatch = null;
        cleanupTapHooks();
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