(function(exports, metro, common, patcher, assets, components, toasts, utils) {
"use strict";

const {
    findByProps,
    findByPropsAll,
    findByStoreName,
    findAll
} = metro;

const {
    clipboard,
    FluxDispatcher,
    React
} = common;

const {
    after,
    before
} = patcher;

const { getAssetIDByName } = assets;
const { Forms } = components;
const { showToast } = toasts;
const { findInReactTree } = utils;

const BUILD = "0.7.0";
const BLUE_MARKER = "🔵 ";
const DEBUG_LIMIT = 220;

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const ActionSheetRow =
    findByProps("ActionSheetRow")?.ActionSheetRow ??
    Forms.FormRow;

const MessageStore = findByStoreName("MessageStore");

const selected = new Map();
const originals = new Map();
const debugLog = [];
const jsxUnpatches = [];
const miscUnpatches = [];
const wrappedTapFns = new WeakMap();
const hookedJsxTargets = new Set();

let selectionMode = false;
let selectionChannelId = null;
let actionSheetUnpatch = null;
let jsxHookCount = 0;
let tapPropSeenCount = 0;
let tapCallCount = 0;

function icon() {
    try {
        return getAssetIDByName("ic_message_copy");
    } catch (_) {
        return undefined;
    }
}

function toast(text) {
    try {
        showToast(text, icon());
    } catch (_) {
        try {
            showToast(text);
        } catch (_) {}
    }
}

function safeKeys(value) {
    try {
        if (!value || (typeof value !== "object" && typeof value !== "function")) {
            return [];
        }
        return Object.keys(value).slice(0, 30);
    } catch (_) {
        return [];
    }
}

function shortValue(value) {
    try {
        if (value == null) return value;
        if (typeof value === "string") {
            return value.length > 180 ? value.slice(0, 180) + "…" : value;
        }
        if (typeof value === "number" || typeof value === "boolean") return value;
        if (Array.isArray(value)) return `[array:${value.length}]`;
        if (typeof value === "function") return `[function:${value.name || "anonymous"}]`;
        return `{${safeKeys(value).join(",")}}`;
    } catch (_) {
        return "[unreadable]";
    }
}

function debug(tag, data) {
    try {
        let line = `${new Date().toISOString()} | ${tag}`;

        if (data !== undefined) {
            if (typeof data === "string") {
                line += ` | ${data}`;
            } else {
                const compact = {};

                for (const [key, value] of Object.entries(data ?? {})) {
                    compact[key] = shortValue(value);
                }

                line += ` | ${JSON.stringify(compact)}`;
            }
        }

        debugLog.push(line);

        if (debugLog.length > DEBUG_LIMIT) {
            debugLog.splice(0, debugLog.length - DEBUG_LIMIT);
        }
    } catch (_) {}
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

    if (!message?.id || !channelId || !FluxDispatcher?.dispatch) {
        debug("paint.skip", {
            id: message?.id,
            channelId,
            dispatcher: Boolean(FluxDispatcher?.dispatch)
        });
        return;
    }

    const key = `${channelId}:${message.id}`;
    const current = getMessage(channelId, message.id, message) ?? message;

    if (enabled) {
        if (!originals.has(key)) {
            let content =
                typeof current.content === "string"
                    ? current.content
                    : "";

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

function setSelected(message, enabled, showToast = true, source = "unknown") {
    const channelId = channelOf(message);

    if (!message?.id || !channelId) {
        debug("selection.invalid-message", {
            source,
            id: message?.id,
            channelId,
            keys: safeKeys(message)
        });
        return;
    }

    if (!selectionChannelId) {
        selectionChannelId = channelId;
    }

    if (channelId !== selectionChannelId) {
        debug("selection.wrong-channel", {
            source,
            channelId,
            expected: selectionChannelId,
            messageId: message.id
        });

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

    debug("selection.changed", {
        source,
        enabled,
        count: selected.size,
        messageId: normalized.id,
        channelId
    });

    if (showToast) {
        toast(`Выбрано: ${selected.size}`);
    }
}

function toggleSelected(message, source) {
    const key = keyOf(message);
    setSelected(message, !selected.has(key), true, source);
}

function cancelSelection(show = true) {
    for (const message of selected.values()) {
        try {
            paint(message, false);
        } catch (_) {}
    }

    selected.clear();
    originals.clear();
    selectionMode = false;
    selectionChannelId = null;

    debug("selection.cancel");

    try {
        LazyActionSheet?.hideActionSheet?.();
    } catch (_) {}

    if (show) {
        toast("Выбор отменён");
    }
}

function beginSelection(message) {
    cancelSelection(false);

    const channelId = channelOf(message);

    if (!message?.id || !channelId) {
        debug("selection.begin-failed", {
            id: message?.id,
            channelId,
            keys: safeKeys(message)
        });
        return;
    }

    selectionMode = true;
    selectionChannelId = channelId;

    setSelected(
        {
            ...message,
            channel_id: channelId
        },
        true,
        false,
        "long-press-menu"
    );

    debug("selection.begin", {
        messageId: message.id,
        channelId,
        jsxHookCount,
        tapPropSeenCount
    });

    try {
        LazyActionSheet?.hideActionSheet?.();
    } catch (_) {}

    toast(`Выбрано: 1 | v${BUILD}`);
}

function extractTapInfo(event) {
    const candidates = [];

    try {
        if (event?.nativeEvent) {
            candidates.push(event.nativeEvent);
        }
    } catch (_) {}

    if (event && typeof event === "object") {
        candidates.push(event);
    }

    for (const data of candidates) {
        const messageId =
            data?.messageId ??
            data?.message_id ??
            data?.message?.id ??
            data?.id;

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
                fallback: data?.message ?? null,
                keys: safeKeys(data)
            };
        }
    }

    return null;
}

function handleObservedTap(event, source = "jsx.onTapMessage") {
    tapCallCount++;

    const info = extractTapInfo(event);

    debug("tap.call", {
        source,
        tapCallCount,
        selectionMode,
        nativeKeys: safeKeys(event?.nativeEvent),
        rootKeys: safeKeys(event),
        messageId: info?.messageId,
        channelId: info?.channelId
    });

    if (!selectionMode) {
        return false;
    }

    if (!info) {
        toast("Tap пойман, но ID сообщения не найден");
        return true;
    }

    const message = getMessage(
        info.channelId,
        info.messageId,
        info.fallback
    );

    debug("tap.resolve", {
        source,
        messageId: info.messageId,
        channelId: info.channelId,
        found: Boolean(message),
        content: message?.content,
        authorId: message?.author?.id,
        author: message?.author?.username
    });

    if (!message) {
        toast(`Tap ${info.messageId}, но MessageStore его не нашёл`);
        return true;
    }

    toggleSelected(
        {
            ...message,
            channel_id: info.channelId
        },
        source
    );

    return true;
}

function wrapTapFunction(original, source) {
    if (typeof original !== "function") {
        return original;
    }

    const existing = wrappedTapFns.get(original);
    if (existing) return existing;

    function wrappedTap() {
        const args = Array.from(arguments);
        const consumed = handleObservedTap(
            args?.[0],
            source
        );

        if (consumed) {
            return;
        }

        return original.apply(this, args);
    }

    wrappedTap.__telegramSelectionOriginal = original;
    wrappedTapFns.set(original, wrappedTap);

    return wrappedTap;
}

function patchJsxRuntime(target, label) {
    if (!target || hookedJsxTargets.has(target)) return;

    const keys = ["jsx", "jsxs", "jsxDEV"];
    let hooked = false;

    for (const key of keys) {
        if (typeof target?.[key] !== "function") continue;

        try {
            const unpatch = before(
                key,
                target,
                args => {
                    try {
                        const props = args?.[1];

                        if (
                            !props ||
                            typeof props !== "object" ||
                            typeof props.onTapMessage !== "function"
                        ) {
                            return;
                        }

                        tapPropSeenCount++;

                        debug("jsx.onTapMessage-prop", {
                            label,
                            key,
                            tapPropSeenCount,
                            propsKeys: safeKeys(props),
                            fnName: props.onTapMessage?.name
                        });

                        const wrapped = wrapTapFunction(
                            props.onTapMessage,
                            `${label}.${key}.onTapMessage`
                        );

                        try {
                            props.onTapMessage = wrapped;
                        } catch (_) {
                            try {
                                args[1] = {
                                    ...props,
                                    onTapMessage: wrapped
                                };
                            } catch (_) {}
                        }

                        return args;
                    } catch (error) {
                        debug("jsx.patch-error", {
                            label,
                            key,
                            error: String(error)
                        });
                    }
                }
            );

            jsxUnpatches.push(unpatch);
            jsxHookCount++;
            hooked = true;
        } catch (error) {
            debug("jsx.hook-failed", {
                label,
                key,
                error: String(error)
            });
        }
    }

    if (hooked) {
        hookedJsxTargets.add(target);
    }
}

function installJsxHooks() {
    const targets = [];

    try {
        if (typeof findByPropsAll === "function") {
            const found = findByPropsAll("jsx", "jsxs");

            if (Array.isArray(found)) {
                targets.push(...found);
            }
        }
    } catch (error) {
        debug("findByPropsAll.jsx.error", String(error));
    }

    if (!targets.length) {
        try {
            if (typeof findAll === "function") {
                const found = findAll(module => {
                    try {
                        return (
                            typeof module?.jsx === "function" ||
                            typeof module?.jsxs === "function" ||
                            typeof module?.default?.jsx === "function" ||
                            typeof module?.default?.jsxs === "function"
                        );
                    } catch (_) {
                        return false;
                    }
                });

                if (Array.isArray(found)) {
                    targets.push(...found);
                }
            }
        } catch (error) {
            debug("findAll.jsx.error", String(error));
        }
    }

    const unique = new Set();

    targets.forEach((target, index) => {
        if (!target || unique.has(target)) return;
        unique.add(target);

        patchJsxRuntime(
            target,
            `jsxRuntime#${index}`
        );

        try {
            if (target.default && target.default !== target) {
                patchJsxRuntime(
                    target.default,
                    `jsxRuntime#${index}.default`
                );
            }
        } catch (_) {}
    });

    debug("jsx.install", {
        targets: unique.size,
        hooks: jsxHookCount
    });
}

function patchDiagnosticFunction(target, key, label) {
    if (!target || typeof target?.[key] !== "function") return;

    try {
        const unpatch = after(
            key,
            target,
            (args, result) => {
                const first = args?.[0];

                debug(`diag.${label}.${key}`, {
                    argKeys: safeKeys(first),
                    nativeKeys: safeKeys(first?.nativeEvent),
                    resultKeys: safeKeys(result),
                    resultMessageId:
                        result?.messageId ??
                        result?.message_id ??
                        result?.id,
                    argMessageId:
                        first?.nativeEvent?.messageId ??
                        first?.messageId
                });
            }
        );

        miscUnpatches.push(unpatch);
    } catch (error) {
        debug("diag.patch-failed", {
            label,
            key,
            error: String(error)
        });
    }
}

function installDiagnosticHooks() {
    const candidates = [];

    try {
        if (typeof findAll === "function") {
            const found = findAll(module => {
                try {
                    const objects = [
                        module,
                        module?.default
                    ];

                    return objects.some(obj =>
                        obj &&
                        (
                            typeof obj.getNativeSyntheticEventData === "function" ||
                            typeof obj.handleTapMessage === "function" ||
                            typeof obj.onTapMessage === "function" ||
                            typeof obj.handleLongPressMessage === "function"
                        )
                    );
                } catch (_) {
                    return false;
                }
            });

            if (Array.isArray(found)) {
                candidates.push(...found);
            }
        }
    } catch (error) {
        debug("diag.findAll.error", String(error));
    }

    const seen = new Set();

    candidates.slice(0, 60).forEach((module, index) => {
        for (const pair of [
            [module, `module#${index}`],
            [module?.default, `module#${index}.default`]
        ]) {
            const target = pair[0];
            const label = pair[1];

            if (!target || seen.has(target)) continue;
            seen.add(target);

            debug("diag.candidate", {
                label,
                keys: safeKeys(target)
            });

            for (const key of [
                "getNativeSyntheticEventData",
                "handleTapMessage",
                "onTapMessage",
                "handleLongPressMessage"
            ]) {
                patchDiagnosticFunction(
                    target,
                    key,
                    label
                );
            }
        }
    });

    try {
        const handlersModule = findByProps("MessagesHandlers");
        const prototype = handlersModule?.MessagesHandlers?.prototype;

        debug("diag.MessagesHandlers", {
            found: Boolean(handlersModule),
            moduleKeys: safeKeys(handlersModule),
            prototypeKeys: safeKeys(prototype)
        });

        if (prototype) {
            for (const name of [
                "params",
                "handlers",
                "_params",
                "messageHandlers"
            ]) {
                let descriptor;

                try {
                    descriptor =
                        Object.getOwnPropertyDescriptor(
                            prototype,
                            name
                        );
                } catch (_) {}

                if (
                    !descriptor?.get ||
                    descriptor.configurable === false
                ) {
                    continue;
                }

                const originalGetter = descriptor.get;

                function wrappedGetter() {
                    const value = originalGetter.call(this);

                    debug("diag.handler-getter", {
                        name,
                        thisKeys: safeKeys(this),
                        valueKeys: safeKeys(value),
                        thisTap: typeof this?.handleTapMessage,
                        valueTap: typeof value?.handleTapMessage
                    });

                    try {
                        patchDiagnosticFunction(
                            this,
                            "handleTapMessage",
                            `instance.${name}.this`
                        );
                    } catch (_) {}

                    try {
                        patchDiagnosticFunction(
                            value,
                            "handleTapMessage",
                            `instance.${name}.value`
                        );
                    } catch (_) {}

                    return value;
                }

                try {
                    Object.defineProperty(
                        prototype,
                        name,
                        {
                            ...descriptor,
                            get: wrappedGetter
                        }
                    );

                    miscUnpatches.push(() => {
                        try {
                            Object.defineProperty(
                                prototype,
                                name,
                                descriptor
                            );
                        } catch (_) {}
                    });
                } catch (error) {
                    debug("diag.getter-wrap-failed", {
                        name,
                        error: String(error)
                    });
                }
            }
        }
    } catch (error) {
        debug("diag.MessagesHandlers.error", String(error));
    }

    debug("diag.install", {
        candidates: candidates.length,
        hooks: miscUnpatches.length
    });
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

        if (Number.isNaN(d.getTime())) {
            return String(timestamp);
        }

        const p = n =>
            String(n).padStart(2, "0");

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
    const username =
        a.username ??
        a.name ??
        "unknown";

    const globalName =
        a.global_name ??
        a.globalName ??
        a.displayName ??
        "";

    const discriminator =
        a.discriminator &&
        a.discriminator !== "0"
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
        const url =
            a?.url ??
            a?.proxy_url ??
            a?.proxyURL ??
            "";

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
    const ref =
        message?.message_reference ??
        message?.messageReference;

    const quoted =
        message?.referenced_message ??
        message?.referencedMessage;

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

        lines.push(
            `Цитируемый автор: ${a.display} | author_id=${a.id}`
        );

        if (quoted.content) {
            lines.push(
                `Цитируемый текст: ${quoted.content}`
            );
        }
    }

    return lines;
}

function messageToText(message) {
    const m = cleanMessage(message);
    const a = authorInfo(m);

    const timestamp =
        m?.timestamp ??
        m?.created_at ??
        m?.createdAt;

    const edited =
        m?.edited_timestamp ??
        m?.editedTimestamp;

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

    if (edited) {
        lines.push(`Изменено: ${formatTime(edited)}`);
    }

    lines.push(...replyLines(m));

    const mentions = toArray(m?.mentions);

    if (mentions.length) {
        lines.push(
            `Упоминания: ${mentions
                .map(
                    u =>
                        `${u?.username ?? u?.global_name ?? "user"}(${u?.id ?? "?"})`
                )
                .join(", ")}`
        );
    }

    const roles = toArray(
        m?.mention_roles ??
        m?.mentionRoles
    );

    if (roles.length) {
        lines.push(
            `Упомянутые роли: ${roles.join(", ")}`
        );
    }

    lines.push("Текст:");
    lines.push(
        typeof m?.content === "string" &&
        m.content.length
            ? m.content
            : "(без текста)"
    );

    lines.push(...attachmentLines(m));

    return lines.join("\n");
}

function sortMessages(messages) {
    return messages.sort((a, b) => {
        const at = Date.parse(a?.timestamp ?? "");
        const bt = Date.parse(b?.timestamp ?? "");

        if (
            Number.isFinite(at) &&
            Number.isFinite(bt) &&
            at !== bt
        ) {
            return at - bt;
        }

        const ai = String(a?.id ?? "");
        const bi = String(b?.id ?? "");

        if (ai.length !== bi.length) {
            return ai.length - bi.length;
        }

        return ai.localeCompare(bi);
    });
}

function copySelected() {
    const messages = sortMessages(
        Array.from(selected.values())
    );

    if (!messages.length) {
        toast("Нет выбранных сообщений");
        return;
    }

    clipboard.setString(
        messages
            .map(messageToText)
            .join(
                "\n\n====================\n\n"
            )
    );

    const count = messages.length;

    debug("selection.copy", {
        count
    });

    cancelSelection(false);
    toast(`Скопировано сообщений: ${count}`);
}

function copyDebug() {
    const header = [
        `Telegram Selection DEBUG v${BUILD}`,
        `selectionMode=${selectionMode}`,
        `selected=${selected.size}`,
        `selectionChannelId=${selectionChannelId ?? ""}`,
        `jsxHookCount=${jsxHookCount}`,
        `tapPropSeenCount=${tapPropSeenCount}`,
        `tapCallCount=${tapCallCount}`,
        `MessageStore=${Boolean(MessageStore)}`,
        `LazyActionSheet=${Boolean(LazyActionSheet)}`,
        `findByPropsAll=${typeof findByPropsAll}`,
        `findAll=${typeof findAll}`,
        ""
    ];

    const text =
        header.join("\n") +
        debugLog.join("\n");

    clipboard.setString(text);
    toast(`Debug скопирован: ${debugLog.length} строк`);
}

function clearDebug() {
    debugLog.length = 0;

    debug("debug.cleared", {
        build: BUILD
    });

    toast("Debug очищен");
}

function makeRow(label, onPress) {
    const props = {
        label,
        onPress
    };

    const source = icon();

    if (
        ActionSheetRow?.Icon &&
        source &&
        React?.createElement
    ) {
        props.icon = React.createElement(
            ActionSheetRow.Icon,
            { source }
        );
    }

    return React.createElement(
        ActionSheetRow,
        props
    );
}

function injectRows(buttons, message) {
    if (!Array.isArray(buttons)) return;

    if (
        buttons.some(
            row =>
                row?.props?.__telegramSelectionRow
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
        const isSelected =
            selected.has(keyOf(message));

        rows.push(
            mark(
                makeRow(
                    isSelected
                        ? "Убрать это сообщение из выбора"
                        : "Добавить это сообщение",
                    () => {
                        setSelected(
                            message,
                            !isSelected,
                            true,
                            "long-press-menu"
                        );

                        try {
                            LazyActionSheet
                                ?.hideActionSheet
                                ?.();
                        } catch (_) {}
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

    rows.push(
        mark(
            makeRow(
                `Скопировать debug [v${BUILD}]`,
                copyDebug
            )
        )
    );

    rows.push(
        mark(
            makeRow(
                "Очистить debug",
                clearDebug
            )
        )
    );

    buttons.splice(
        0,
        0,
        ...rows
    );
}

function patchActionSheet() {
    if (
        !LazyActionSheet ||
        actionSheetUnpatch
    ) {
        return;
    }

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

            debug("longpress.open", {
                messageId: message.id,
                channelId: channelOf(message),
                selectionMode,
                selected: selected.size
            });

            component.then(instance => {
                const unpatch = after(
                    "default",
                    instance,
                    (_, result) => {
                        setTimeout(() => {
                            try {
                                unpatch();
                            } catch (_) {}
                        }, 0);

                        const buttons =
                            findInReactTree(
                                result,
                                node =>
                                    Array.isArray(node) &&
                                    node.some?.(
                                        item =>
                                            item?.type
                                                ?.name ===
                                                "ActionSheetRow" ||
                                            item?.props
                                                ?.label
                                    )
                            );

                        if (!buttons) {
                            debug(
                                "longpress.buttons-not-found"
                            );
                            return;
                        }

                        const channelId =
                            channelOf(message);

                        const current =
                            getMessage(
                                channelId,
                                message.id,
                                message
                            );

                        injectRows(
                            buttons,
                            current
                        );
                    }
                );
            });
        }
    );
}

function cleanup() {
    for (const unpatch of jsxUnpatches) {
        try {
            unpatch?.();
        } catch (_) {}
    }

    jsxUnpatches.length = 0;

    for (const unpatch of miscUnpatches) {
        try {
            unpatch?.();
        } catch (_) {}
    }

    miscUnpatches.length = 0;

    try {
        actionSheetUnpatch?.();
    } catch (_) {}

    actionSheetUnpatch = null;

    cancelSelection(false);
}

const pluginDefinition = {
    onLoad() {
        debug("plugin.load", {
            build: BUILD,
            metroKeys: safeKeys(metro),
            commonKeys: safeKeys(common),
            MessageStore: Boolean(MessageStore),
            LazyActionSheet: Boolean(LazyActionSheet)
        });

        installJsxHooks();
        installDiagnosticHooks();
        patchActionSheet();

        debug("plugin.ready", {
            jsxHookCount,
            miscHooks: miscUnpatches.length
        });
    },

    onUnload() {
        debug("plugin.unload");
        cleanup();
    }
};

exports.default = pluginDefinition;

Object.defineProperty(
    exports,
    "__esModule",
    { value: true }
);

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
