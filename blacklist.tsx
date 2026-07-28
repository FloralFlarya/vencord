/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, MediaEngineStore, MessageStore, RestAPI, SoundboardStore, TypingStore, UserStore } from "@webpack/common";

const MediaEngineActions = findByPropsLazy("setLocalVolume", "setLocalPan") as {
    setLocalVolume: (userId: string, volume: number) => void;
};

const ChannelNotificationActions = findByPropsLazy("updateChannelOverrideSettings") as {
    updateChannelOverrideSettings: (guildId: string | null, channelId: string, settings: object) => void;
};

const RelationshipActions = findByPropsLazy("ignoreUser", "unignoreUser") as {
    ignoreUser?: (userId: string) => Promise<unknown> | unknown;
    unignoreUser?: (userId: string) => Promise<unknown> | unknown;
};

const settings = definePluginSettings({
    users: {
        type: OptionType.STRING,
        description: "Discord user IDs whose direct-message notifications are muted.",
        default: "",
        hidden: true
    },
    voiceVolumes: {
        type: OptionType.STRING,
        description: "Saved voice volumes for users muted by Blacklist.",
        default: "{}",
        hidden: true
    },
    soundboardMutes: {
        type: OptionType.STRING,
        description: "Saved Soundboard mute states for users muted by Blacklist.",
        default: "{}",
        hidden: true
    }
});

let observer: MutationObserver | undefined;
let refreshFrame = 0;
let originalGetTypingUsers: ((channelId: string) => Record<string, number>) | undefined;

function ids(): string[] {
    return [...new Set((settings.store.users.match(/\d{17,20}/g) ?? []))];
}

function saveIds(next: string[]) {
    const previous = new Set(ids());
    const nextSet = new Set(next);
    settings.store.users = [...new Set(next)].join(",");
    for (const id of nextSet) if (!previous.has(id)) {
        muteVoice(id);
        muteSoundboard(id);
        void setIgnored(id, true);
    }
    for (const id of previous) if (!nextSet.has(id)) {
        restoreVoice(id);
        restoreSoundboard(id);
        void setIgnored(id, false);
    }
    refreshUnblockChoices();
    refreshDom();
    (TypingStore as any).emitChange?.();
}

async function setIgnored(userId: string, ignored: boolean) {
    try {
        const action = ignored ? RelationshipActions.ignoreUser : RelationshipActions.unignoreUser;
        if (typeof action === "function") {
            await action(userId);
            return;
        }
        const url = `/users/@me/relationships/${userId}/ignore`;
        if (ignored) await RestAPI.put({ url });
        else await RestAPI.del({ url });
    } catch (error) {
        console.warn(`[Blacklist] Failed to ${ignored ? "ignore" : "unignore"} ${userId}`, error);
    }
}

function muteDirectMessage(userId: string) {
    const channelId = ChannelStore.getDMFromUserId(userId);
    if (!channelId) return;

    ChannelNotificationActions.updateChannelOverrideSettings(null, channelId, {
        muted: true,
        mute_config: { selected_time_window: -1, end_time: null }
    });
}

function unmuteDirectMessage(userId: string) {
    const channelId = ChannelStore.getDMFromUserId(userId);
    if (!channelId) return;

    ChannelNotificationActions.updateChannelOverrideSettings(null, channelId, {
        muted: false,
        mute_config: null
    });
}

function muteBlockedDirectMessages() {
    ids().forEach(muteDirectMessage);
}

function savedVolumes(): Record<string, number> {
    try {
        return JSON.parse(settings.store.voiceVolumes || "{}");
    } catch {
        return {};
    }
}

function muteVoice(userId: string) {
    const volumes = savedVolumes();
    if (!(userId in volumes)) {
        volumes[userId] = MediaEngineStore.getLocalVolume(userId) ?? 100;
        settings.store.voiceVolumes = JSON.stringify(volumes);
    }
    MediaEngineActions.setLocalVolume(userId, 0);
}

function restoreVoice(userId: string) {
    const volumes = savedVolumes();
    MediaEngineActions.setLocalVolume(userId, volumes[userId] ?? 100);
    delete volumes[userId];
    settings.store.voiceVolumes = JSON.stringify(volumes);
}

function savedSoundboardMutes(): Record<string, boolean> {
    try {
        return JSON.parse(settings.store.soundboardMutes || "{}");
    } catch {
        return {};
    }
}

function muteSoundboard(userId: string) {
    const states = savedSoundboardMutes();
    if (!(userId in states)) {
        states[userId] = SoundboardStore.isLocalSoundboardMuted(userId);
        settings.store.soundboardMutes = JSON.stringify(states);
    }
    if (!SoundboardStore.isLocalSoundboardMuted(userId)) {
        FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_SOUNDBOARD_MUTE", userId });
    }
}

function restoreSoundboard(userId: string) {
    const states = savedSoundboardMutes();
    if (!states[userId] && SoundboardStore.isLocalSoundboardMuted(userId)) {
        FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_SOUNDBOARD_MUTE", userId });
    }
    delete states[userId];
    settings.store.soundboardMutes = JSON.stringify(states);
}

function muteBlockedVoices() {
    ids().forEach(id => {
        muteVoice(id);
        muteSoundboard(id);
    });
}

function filterTypingUsers(channelId: string): Record<string, number> {
    const typingUsers = originalGetTypingUsers?.(channelId) ?? {};
    const blocked = new Set(ids());
    return Object.fromEntries(Object.entries(typingUsers).filter(([userId]) => !blocked.has(userId)));
}

async function restoreUserMessages(channelId: string, userId: string) {
    const cached = (MessageStore.getMessages(channelId) as any)?._array as any[] | undefined;
    const oldestCachedId = cached?.[0]?.id;
    let before: string | undefined;

    for (let page = 0; page < 25; page++) {
        const response = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: { limit: 100, ...(before && { before }) }
        });
        const messages = response.body as any[];
        if (!messages?.length) break;

        for (const message of [...messages].reverse()) {
            if (message.author?.id !== userId) continue;
            FluxDispatcher.dispatch({
                type: "MESSAGE_CREATE",
                message,
                optimistic: false,
                isPushNotification: false,
                isHistory: true
            });
        }

        if (oldestCachedId && messages.some(message => message.id === oldestCachedId)) break;
        if (messages.length < 100) break;
        before = messages[messages.length - 1].id;
    }
}

function getCommandId(args: any[]): string | undefined {
    const value = String(findOption<string>(args, "user") ?? "");
    return value.match(/\d{17,20}/)?.[0];
}

function displayName(id: string): string {
    const user = UserStore.getUser(id);
    return user ? `${user.globalName ?? user.username} (${id})` : id;
}

const unblockUserOption = {
    name: "user",
    description: "Select a user from the blacklist",
    type: ApplicationCommandOptionType.STRING,
    required: true,
    choices: [] as Array<{ name: string; displayName: string; label: string; value: string; }>
};

function refreshUnblockChoices() {
    unblockUserOption.choices = ids().map(id => {
        const user = UserStore.getUser(id);
        const name = user?.globalName ?? user?.username ?? id;
        return { name, displayName: name, label: name, value: id };
    });
}

function snowflake(value: unknown): string | undefined {
    return typeof value === "string" && /^\d{17,20}$/.test(value) ? value : undefined;
}

function userIdFromProps(props: any, message: boolean): string | undefined {
    if (!props || typeof props !== "object") return;

    if (message) {
        const id = snowflake(props.message?.author?.id) ?? snowflake(props.baseMessage?.author?.id);
        if (id) return id;
    } else {
        // Reaction avatars in current Discord builds are rendered by
        // UserSummaryItem. For one-person reactions it exposes the reactor in
        // `users`, rather than `user`, so the old DOM-only filter missed them.
        const summaryUser = Array.isArray(props.users) && props.users.length === 1
            ? props.users[0]
            : undefined;
        const summaryUserId = Array.isArray(props.userIds) && props.userIds.length === 1
            ? props.userIds[0]
            : undefined;
        const id = snowflake(props.user?.id)
            ?? snowflake(summaryUser?.id)
            ?? snowflake(summaryUserId)
            ?? snowflake(props.reaction?.user?.id)
            ?? snowflake(props.reaction?.userId)
            ?? snowflake(props.member?.userId)
            ?? snowflake(props.member?.user?.id)
            ?? snowflake(props.voiceState?.userId)
            ?? snowflake(props.voiceState?.user?.id)
            ?? snowflake(props.userId);
        if (id) return id;
    }
}

function userIdFromReact(element: HTMLElement, message: boolean): string | undefined {
    const fiberKey = Object.keys(element).find(key => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? (element as any)[fiberKey] : undefined;

    // The DOM node's fiber usually belongs to the host <li>. Its parent fibers
    // contain the component props, including the actual Message/User object.
    for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
        const id = userIdFromProps(fiber.memoizedProps, message)
            ?? userIdFromProps(fiber.pendingProps, message);
        if (id) return id;
    }
}

function authorIdInside(value: any, depth = 0, seen = new Set<any>()): string | undefined {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return;
    seen.add(value);

    const direct = snowflake(value.author?.id) ?? snowflake(value.message?.author?.id);
    if (direct) return direct;

    for (const child of Object.values(value)) {
        const id = authorIdInside(child, depth + 1, seen);
        if (id) return id;
    }
}

function referencedUserIdFromReact(element: HTMLElement): string | undefined {
    const fiberKey = Object.keys(element).find(key => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? (element as any)[fiberKey] : undefined;

    for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
        for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
            if (!props || typeof props !== "object") continue;
            const id = authorIdInside(props.referencedMessage ?? props.referenced_message);
            if (id) return id;

            for (const [key, value] of Object.entries(props)) {
                if (!key.toLowerCase().includes("referenc")) continue;
                const nestedId = authorIdInside(value);
                if (nestedId) return nestedId;
            }
        }
    }
}

function hide(element: HTMLElement) {
    element.style.setProperty("display", "none", "important");
    element.dataset.vcBlacklistHidden = "true";
}

function roleCountTextNode(header: HTMLElement): Text | undefined {
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    let result: Text | undefined;
    while ((node = walker.nextNode() as Text | null)) {
        if (/\d+/.test(node.nodeValue ?? "")) result = node;
    }
    return result;
}

function updateRoleCount(header: HTMLElement, hiddenCount: number) {
    const node = roleCountTextNode(header);
    if (!node) return;

    const current = node.nodeValue?.match(/\d+(?!.*\d)/)?.[0];
    if (!current) return;
    header.dataset.vcBlacklistOriginalCount ??= current;
    const original = Number(header.dataset.vcBlacklistOriginalCount);
    node.nodeValue = node.nodeValue!.replace(/\d+(?!.*\d)/, String(Math.max(0, original - hiddenCount)));
}

function restoreRoleCounts(removeMarker = false) {
    document.querySelectorAll<HTMLElement>("[data-vc-blacklist-original-count]").forEach(header => {
        const node = roleCountTextNode(header);
        const original = header.dataset.vcBlacklistOriginalCount;
        if (node && original) node.nodeValue = node.nodeValue!.replace(/\d+(?!.*\d)/, original);
        if (removeMarker) delete header.dataset.vcBlacklistOriginalCount;
    });
}

function hideEmptyRoleGroups() {
    document.querySelectorAll<HTMLElement>("[class*='membersGroup']").forEach(header => {
        const wrapper = header.parentElement ?? header;
        let sibling = wrapper.nextElementSibling as HTMLElement | null;
        let sawMember = false;
        let hasVisibleMember = false;
        let hiddenCount = 0;

        while (sibling) {
            if (sibling.matches("[class*='membersGroup']") || sibling.querySelector("[class*='membersGroup']")) break;

            const member = sibling.matches("[data-list-item-id], [role='listitem']")
                ? sibling
                : sibling.querySelector<HTMLElement>("[data-list-item-id], [role='listitem']");

            if (member) {
                sawMember = true;
                const row = member.closest<HTMLElement>("[role='listitem']") ?? member;
                if (row.dataset.vcBlacklistHidden) hiddenCount++;
                else hasVisibleMember = true;
            }

            sibling = sibling.nextElementSibling as HTMLElement | null;
        }

        updateRoleCount(header, hiddenCount);
        if (sawMember && !hasVisibleMember) hide(wrapper);
    });
}

function hideEmptyVoiceChannels() {
    document.querySelectorAll<HTMLElement>("[class*='containerDefault']").forEach(container => {
        const voiceUsers = [...container.querySelectorAll<HTMLElement>("[class*='voiceUser']")];
        if (!voiceUsers.length) return;

        const hasVisibleUser = voiceUsers.some(element => {
            const row = element.closest<HTMLElement>("[class*='draggable']")
                ?? element.closest<HTMLElement>("[class*='voiceUser']")
                ?? element;
            return !row.dataset.vcBlacklistHidden;
        });

        if (!hasVisibleUser) hide(container);
    });
}

function reactionContainer(element: HTMLElement): HTMLElement | undefined {
    let current: HTMLElement | null = element;

    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
        if (current.matches("button, [role='button']")) return current;

        const className = typeof current.className === "string" ? current.className : "";
        if (/reaction/i.test(className) && /\d+/.test(current.textContent ?? "")) return current;
    }
}

function isAddReactionControl(element: HTMLElement): boolean {
    const className = typeof element.className === "string" ? element.className : "";
    // Discord 2026: the message action button has no accessible label. Its
    // stable generated class pair identifies the forced Add Reaction control.
    if (/(?:^|\s)reactionBtn__\S+/.test(className) && /(?:^|\s)forceShow__\S+/.test(className)) return true;
    const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("data-tooltip-content"),
        element.getAttribute("title"),
        element.textContent
    ].filter(Boolean).join(" ");
    return /add reaction|добавить реакцию/i.test(label);
}

function hideEmptyReactionControls() {
    document.querySelectorAll<HTMLElement>("button, [role='button']").forEach(control => {
        if (!isAddReactionControl(control)) return;

        const row = control.closest<HTMLElement>("li[id^='chat-messages-']");
        if (!row) return;
        const hasVisibleReaction = [...row.querySelectorAll<HTMLElement>("button, [role='button']")]
            .some(button => {
                if (button === control || button.dataset.vcBlacklistHidden || isAddReactionControl(button)) return false;
                const className = typeof button.className === "string" ? button.className : "";
                return /reaction/i.test(className)
                    || Boolean(button.querySelector("[class*='reaction']"));
            });

        // The control belongs to the message action bar, not the reaction pill.
        // Keep it only when the message still has a non-hidden reaction.
        if (!hasVisibleReaction) hide(control);
    });
}

function hideTooltipLinkedAddReactionControls() {
    document.querySelectorAll<HTMLElement>("[role='tooltip'], [id*='tooltip']").forEach(tooltip => {
        if (!/add reaction|добавить реакцию/i.test(tooltip.textContent ?? "")) return;
        const tooltipId = tooltip.id;
        if (!tooltipId) return;

        document.querySelectorAll<HTMLElement>("[aria-describedby], [aria-controls], [data-tooltip-id]").forEach(control => {
            const referencesTooltip = [
                control.getAttribute("aria-describedby"),
                control.getAttribute("aria-controls"),
                control.getAttribute("data-tooltip-id")
            ].some(value => value?.split(/\s+/).includes(tooltipId));
            if (referencesTooltip) hide(control);
        });
    });
}

function hideBlockedReactions(blocked: Set<string>) {
    const selectors = [
        "[class*='reaction'] [class*='avatar']",
        "[class*='reaction'] img",
        "[class*='reaction'] [style*='background-image']"
    ].join(",");

    document.querySelectorAll<HTMLElement>(selectors).forEach(avatar => {
        const userId = userIdFromReact(avatar, false);
        if (!userId || !blocked.has(userId)) return;

        const reaction = reactionContainer(avatar);
        const count = Number(reaction?.textContent?.match(/\d+/)?.[0] ?? 0);

        // With one reactor the whole pill belongs to the blocked user. For a
        // shared reaction only their avatar is removed, preserving other users.
        if (reaction && count <= 1) {
            hide(reaction);
            const row = reaction.closest<HTMLElement>("li[id^='chat-messages-']");
            if (row) row.dataset.vcBlacklistReactionHidden = "true";
        }
        else hide(avatar);
    });

    hideEmptyReactionControls();
    hideTooltipLinkedAddReactionControls();
}

function hideBlockedMentions(row: HTMLElement, blocked: Set<string>) {
    const blockedNames = new Set(
        [...blocked]
            .map(id => UserStore.getUser(id))
            .flatMap(user => user ? [user.username, user.globalName] : [])
            .filter((name): name is string => !!name)
            .map(name => name.trim().toLowerCase())
    );

    row.querySelectorAll<HTMLElement>("[class*='mention']").forEach(mention => {
        const text = mention.textContent?.trim() ?? "";
        if (!text.startsWith("@")) return;

        const userId = userIdFromReact(mention, false);
        const displayedName = text.slice(1).trim().toLowerCase();
        if (userId && blocked.has(userId) || blockedNames.has(displayedName)) hide(mention);
    });
}

function refreshDom() {
    const blocked = new Set(ids());

    restoreRoleCounts();

    document.querySelectorAll<HTMLElement>("[data-vc-blacklist-hidden]").forEach(element => {
        element.style.removeProperty("display");
        delete element.dataset.vcBlacklistHidden;
    });
    document.querySelectorAll<HTMLElement>("[data-vc-blacklist-reaction-hidden]").forEach(element => {
        delete element.dataset.vcBlacklistReactionHidden;
    });

    if (!blocked.size) return;

    // Hide every mounted message, including history loaded before /bl.
    document.querySelectorAll<HTMLElement>("li[id^='chat-messages-']").forEach(row => {
        const authorId = userIdFromReact(row, true);
        if (authorId && blocked.has(authorId)) hide(row);

        row.querySelectorAll<HTMLElement>("[class*='repliedMessage']").forEach(reply => {
            const referencedAuthorId = referencedUserIdFromReact(reply);
            const hasBlockedName = [...blocked].some(id => {
                const user = UserStore.getUser(id);
                if (!user) return false;
                const text = reply.textContent?.toLowerCase() ?? "";
                return [user.username, user.globalName].some(name => name && text.includes(name.toLowerCase()));
            });
            if (referencedAuthorId && blocked.has(referencedAuthorId) || hasBlockedName) hide(reply);
        });

        hideBlockedMentions(row, blocked);
    });

    // Hide guild member rows and DM entries. New Discord builds no longer
    // consistently include the snowflake in data-list-item-id, so React props
    // are used as the source of truth and the DOM id remains a fast fallback.
    document.querySelectorAll<HTMLElement>("[data-list-item-id], [role='listitem']").forEach(element => {
        if (element.id?.startsWith("chat-messages-")) return;

        const row = element.closest<HTMLElement>("[role='listitem']") ?? element;
        const itemId = element.dataset.listItemId ?? row.dataset.listItemId ?? "";
        const idFromAttribute = [...blocked].find(id => itemId.includes(id));
        const memberId = idFromAttribute ?? userIdFromReact(element, false) ?? userIdFromReact(row, false);
        if (memberId && blocked.has(memberId)) hide(row);
    });

    // Users shown under voice channels in the server channel list are not
    // regular list items, but their React props still expose user/voiceState.
    document.querySelectorAll<HTMLElement>("[class*='voiceUser']").forEach(element => {
        const voiceUserId = userIdFromReact(element, false);
        if (!voiceUserId || !blocked.has(voiceUserId)) return;

        // Discord wraps voice users in a draggable row with its own fixed
        // height. Hiding only voiceUser leaves a blank slot in the channel.
        const row = element.closest<HTMLElement>("[class*='draggable']")
            ?? element.closest<HTMLElement>("[class*='voiceUser']")
            ?? element;
        hide(row);
    });

    hideEmptyRoleGroups();
    hideEmptyVoiceChannels();
    hideBlockedReactions(blocked);
    muteBlockedVoices();
}

function scheduleRefresh() {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
        refreshFrame = 0;
        refreshDom();
    });
}

function list(channelId: string) {
    const users = ids();
    sendBotMessage(channelId, {
        content: users.length
            ? `Скрытые пользователи (${users.length}):\n${users.map(id => `• ${displayName(id)}`).join("\n")}`
            : "Список скрытых пользователей пуст"
    });
}

export default definePlugin({
    name: "Blacklist",
    description: "Hides selected users, ignores their direct messages and mutes their voice audio locally.",
    authors: [{ id: 435847641041993759n, name: "Flarya" }],
    dependencies: ["CommandsAPI"],
    settings,

    patches: [
        {
            // Do not put newly received messages from hidden users into MessageStore.
            find: '"MessageStore"',
            replacement: {
                match: /(?<=MESSAGE_CREATE:function\((\i)\)\{)/,
                replace: (_, props) => `if($self.shouldHideMessage(${props}.message))return;`
            }
        },
        {
            // Do not let hidden messages create unread markers or notifications.
            find: '"ReadStateStore"',
            replacement: {
                match: /(?<=MESSAGE_CREATE:function\((\i)\)\{)/,
                replace: (_, props) => `if($self.shouldHideMessage(${props}.message))return;`
            }
        },
        {
            // Hide messages that were already loaded before the plugin started.
            find: "Message must not be a thread starter message",
            replacement: {
                match: /\)\("li",\{(.+?),className:/,
                replace: ")('li',{$1,style:$self.hiddenMessageStyle(arguments[0]?.message),className:"
            }
        },
        {
            // Suppress desktop notifications and mention sounds from hidden users.
            find: ".getDesktopType()===",
            replacement: {
                match: /(\i\.\i\.getDesktopType\(\)===\i\.\i\.NEVER\)\))/,
                replace: "$&if($self.shouldHideMessage(arguments[0]?.message))return;"
            }
        }
    ],

    commands: [
        {
            name: "block",
            description: "Ignore a user locally, or show the ignore list",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "user",
                    description: "Select a user or paste their Discord ID",
                    type: ApplicationCommandOptionType.USER,
                    required: false
                }
            ],
            execute: (args, ctx) => {
                const id = getCommandId(args);
                if (!id) return list(ctx.channel.id);
                if (id === UserStore.getCurrentUser()?.id) {
                    return sendBotMessage(ctx.channel.id, { content: "Нельзя скрыть самого себя." });
                }

                const current = ids();
                if (current.includes(id)) {
                    return sendBotMessage(ctx.channel.id, { content: `${displayName(id)} уже скрыт.` });
                }

                saveIds([...current, id]);
                sendBotMessage(ctx.channel.id, { content: `${displayName(id)} добавлен в список` });
            }
        },
        {
            name: "unblock",
            description: "Stop ignoring a user locally",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [unblockUserOption],
            execute: (args, ctx) => {
                const id = getCommandId(args);
                if (!id) {
                    sendBotMessage(ctx.channel.id, { content: "Укажите пользователя или вставьте его ID в поле `user`." });
                    return;
                }

                const current = ids();
                if (!current.includes(id)) {
                    return sendBotMessage(ctx.channel.id, { content: `${displayName(id)} отсутствует в списке.` });
                }

                saveIds(current.filter(userId => userId !== id));
                void restoreUserMessages(ctx.channel.id, id)
                    .catch(error => {
                        console.error("[Blacklist] Failed to restore messages", error);
                        sendBotMessage(ctx.channel.id, { content: "Не удалось автоматически восстановить часть сообщений. Переключите канал и вернитесь обратно." });
                    });
                sendBotMessage(ctx.channel.id, { content: `${displayName(id)} удалён из списка` });
            }
        }
    ],

    shouldHideMessage(message?: Message) {
        return !!message?.author?.id && ids().includes(message.author.id);
    },

    hiddenMessageStyle(message?: Message) {
        return this.shouldHideMessage(message) ? { display: "none" } : undefined;
    },

    start() {
        refreshUnblockChoices();
        originalGetTypingUsers = TypingStore.getTypingUsers.bind(TypingStore);
        TypingStore.getTypingUsers = filterTypingUsers;
        muteBlockedVoices();
        ids().forEach(id => void setIgnored(id, true));
        refreshDom();
        observer = new MutationObserver(scheduleRefresh);
        observer.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        observer?.disconnect();
        observer = undefined;
        if (originalGetTypingUsers) TypingStore.getTypingUsers = originalGetTypingUsers;
        originalGetTypingUsers = undefined;
        (TypingStore as any).emitChange?.();
        ids().forEach(id => {
            restoreVoice(id);
            restoreSoundboard(id);
        });
        cancelAnimationFrame(refreshFrame);
        refreshFrame = 0;
        document.querySelectorAll<HTMLElement>("[data-vc-blacklist-hidden]").forEach(element => {
            element.style.removeProperty("display");
            delete element.dataset.vcBlacklistHidden;
        });
        restoreRoleCounts(true);
    }
});
