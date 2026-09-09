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
    return `${message.channel_id}:${message.id}`;
}

function paintMessage(message, value) {
    if (!message?.id || !message?.channel_id || !FluxDispatcher?.dispatch) return;

    const key = messageKey(message);
    const current = getMessage(message.channel_id, message.id, message) ?? message;

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

function setSelected(message, value) {
    if (!message?.id || !message?.channel_id) return;

    if (!selectionChannelId) selectionChannelId = message.channel_id;
    if (message.channel_id !== selectionChannelId) {
        toast("Сначала закончи выбор в текущем чате");
        return;
    }

    const key = messageKey(message);
    if (value) {
        const cleanMessage = {
            ...message,
            content: visualOriginals.get(key) ?? message.content
        };
        selected.set(key, cleanMessage);
        paintMessage(message, true);
    } else {
        selected.delete(key);
        paintMessage(message, false);
    }

    toast(`Выбрано: ${selected.size}`);
}

function toggleSelected(message) {
    if (!message?.id || !message?.channel_id) return;
    const key = messageKey(message);
    setSelected(message, !selected.has(key));
}

function beginSelection(message) {
    selected.clear();
    selectionMode = true;
    selectionChannelId = message.channel_id;
    setSelected(message, true);
    LazyActionSheet?.hideActionSheet?.();
    toast("Режим выбора включён. Нажимай на другие сообщения");
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

function attachmentUrls(message) {
    const attachments = message?.attachments;
    if (!attachments) return [];

    const list = Array.isArray(attachments)
        ? attachments
        : typeof attachments?.toArray === "function"
            ? attachments.toArray()
            : typeof attachments?.values === "function"
                ? Array.from(attachments.values())
                : Object.values(attachments);

    return list
        .map(a => a?.url ?? a?.proxy_url)
        .filter(Boolean);
}

function messageToText(message) {
    const parts = [];
    if (typeof message?.content === "string" && message.content.length) {
        parts.push(message.content);
    }
    parts.push(...attachmentUrls(message));
    return parts.join("\n");
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
    const text = messages
        .map(messageToText)
        .filter(Boolean)
        .join("\n\n");

    if (!text) {
        toast("В выбранных сообщениях нет текста или файлов");
        return;
    }

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
            isSelected ? "Убрать из выбранного" : "Добавить в выбранное",
            () => {
                toggleSelected(message);
                LazyActionSheet?.hideActionSheet?.();
            }
        )));

        if (selected.size > 0) {
            rows.push(mark(makeRow(`Скопировать выбранные (${selected.size})`, copySelected)));
        }

        rows.push(mark(makeRow("Отменить выбор", () => cancelSelection(true))));
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

            const nativeEvent = args?.[0]?.nativeEvent;
            const channelId = nativeEvent?.channelId;
            const messageId = nativeEvent?.messageId;
            if (!channelId || !messageId) return;

            const message = getMessage(channelId, messageId);
            if (!message) return;

            toggleSelected(message);
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
                    const current = getMessage(message.channel_id, message.id, message);
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
