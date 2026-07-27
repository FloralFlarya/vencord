/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Flarya
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { User } from "@vencord/discord-types";
import { GuildMemberStore, GuildRoleStore, GuildStore, PermissionsBits, SelectedGuildStore, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    useRoleColor: {
        type: OptionType.BOOLEAN,
        description: "Use the member's role color for the tag",
        default: false
    },
    showInChat: {
        type: OptionType.BOOLEAN,
        description: "Show staff tags next to names in chat",
        default: true,
        restartNeeded: true
    },
    showInMemberList: {
        type: OptionType.BOOLEAN,
        description: "Show staff tags in the server member list",
        default: true,
        restartNeeded: true
    }
});

interface StaffTag {
    text: string;
    color: string;
}

type PermissionName = keyof typeof PermissionsBits;

const TAGS: Array<{ text: string; color: string; permissions: PermissionName[]; }> = [
    { text: "ADMIN", color: "#ed4245", permissions: ["ADMINISTRATOR"] },
    {
        text: "STAFF",
        color: "#57f287",
        permissions: [
            "MANAGE_GUILD",
            "MANAGE_CHANNELS",
            "MANAGE_ROLES",
            "MANAGE_WEBHOOKS"
        ]
    },
    {
        text: "MOD",
        color: "#5865f2",
        permissions: ["MANAGE_MESSAGES", "KICK_MEMBERS", "BAN_MEMBERS"]
    },
    {
        text: "VC MOD",
        color: "#00a8fc",
        permissions: ["MOVE_MEMBERS", "MUTE_MEMBERS", "DEAFEN_MEMBERS"]
    },
    { text: "CHAT MOD", color: "#9b59b6", permissions: ["MODERATE_MEMBERS"] }
];

function getPermissions(guildId: string, userId: string): bigint {
    const guild = GuildStore.getGuild(guildId);
    const member = GuildMemberStore.getMember(guildId, userId);
    if (!guild || !member) return 0n;

    const roles = [
        GuildRoleStore.getEveryoneRole(guild),
        ...GuildRoleStore.getManyRoles(guildId, member.roles)
    ];

    return roles.reduce((permissions, role) => permissions | (role?.permissions ?? 0n), 0n);
}

function getTag(guildId: string | undefined, user: User, isOwner = false): StaffTag | null {
    if (!guildId || !user || user.bot) return null;

    const guild = GuildStore.getGuild(guildId);
    if (!guild) return null;

    const member = GuildMemberStore.getMember(guildId, user.id);
    if (isOwner || guild.ownerId === user.id) {
        return { text: "OWNER", color: settings.store.useRoleColor && member?.colorString || "#f0b232" };
    }

    const permissions = getPermissions(guildId, user.id);

    for (const tag of TAGS) {
        if (!tag.permissions.some(permissionName => {
            const permission = PermissionsBits[permissionName];
            return (permissions & permission) === permission;
        })) continue;
        return {
            text: tag.text,
            color: settings.store.useRoleColor && member?.colorString || tag.color
        };
    }

    return null;
}

function textColorFor(background: string): string {
    const match = background.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
    if (!match) return "#fff";

    const hex = match[1].length === 3
        ? [...match[1]].map(value => value + value).join("")
        : match[1];
    const red = parseInt(hex.slice(0, 2), 16);
    const green = parseInt(hex.slice(2, 4), 16);
    const blue = parseInt(hex.slice(4, 6), 16);
    const luminance = (red * 299 + green * 587 + blue * 114) / 255000;
    return luminance > 0.62 ? "#111" : "#fff";
}

function StaffBadge({ guildId, user, isOwner }: { guildId?: string; user: User; isOwner?: boolean; }) {
    const tag = getTag(guildId, user, isOwner);
    if (!tag) return null;

    return (
        <span
            className="vc-stafftag"
            style={{ backgroundColor: tag.color, color: textColorFor(tag.color) }}
            title={`Staff Tags: ${tag.text}`}
        >
            {tag.text}
        </span>
    );
}

export default definePlugin({
    name: "StaffTags",
    description: "Shows OWNER, ADMIN, STAFF and moderator tags based on server permissions.",
    authors: [
        { name: "Fiery", id: 890228870559698955n },
        { name: "siguma", id: 737597276339437578n },
        { name: "Flarya", id: 435847641041993759n }
    ],
    dependencies: ["CommandsAPI", "MessageDecorationsAPI", "MemberListDecoratorsAPI"],
    settings,

    commands: [{
        name: "stafftagdebug",
        description: "Show StaffTags permission diagnostics for a user",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [{
            name: "user",
            description: "User to inspect",
            type: ApplicationCommandOptionType.USER,
            required: true
        }],
        execute: (args, ctx) => {
            const userId = findOption<string>(args, "user");
            const guildId = ctx.guild?.id ?? ctx.channel.guild_id;
            const user = userId ? UserStore.getUser(userId) : undefined;
            const member = guildId && userId ? GuildMemberStore.getMember(guildId, userId) : undefined;

            if (!guildId || !user || !member) {
                sendBotMessage(ctx.channel.id, {
                    content: `StaffTags debug: guild=${guildId ?? "none"}, user=${userId ?? "none"}, cachedUser=${!!user}, cachedMember=${!!member}`
                });
                return;
            }

            const rolePermissions = [guildId, ...member.roles].map(roleId => {
                const role = GuildRoleStore.getRole(guildId, roleId);
                return `${role?.name ?? roleId}=${role?.permissions?.toString() ?? "missing"}`;
            });

            const computed = getPermissions(guildId, user.id);
            const tag = getTag(guildId, user);
            sendBotMessage(ctx.channel.id, {
                content: [
                    `StaffTags debug for ${user.username} (${user.id})`,
                    `guild=${guildId}`,
                    `computedType=${typeof computed}`,
                    `computed=${String(computed)}`,
                    `tag=${tag?.text ?? "none"}`,
                    `roles: ${rolePermissions.join("; ")}`
                ].join("\n")
            });
        }
    }],

    start() {
        if (settings.store.showInChat) {
            addMessageDecoration("StaffTags", ({ channel, message }) => (
                <StaffBadge guildId={channel.guild_id ?? undefined} user={message.author} />
            ));
        }

        if (settings.store.showInMemberList) {
            addMemberListDecorator("StaffTags", props => {
                const guildId = (props as typeof props & { guildId?: string; }).guildId
                    ?? SelectedGuildStore.getGuildId()
                    ?? undefined;
                return <StaffBadge guildId={guildId} user={props.user} isOwner={props.isOwner} />;
            }, "guilds");
        }
    },

    stop() {
        removeMessageDecoration("StaffTags");
        removeMemberListDecorator("StaffTags");
    }
});
