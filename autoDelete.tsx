import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Constants, RestAPI, UserStore } from "@webpack/common";

const MIN_INTERVAL = 1000;
const DEFAULT_INTERVAL = 1500;
const MAX_MESSAGES = 5000;
const MAX_PASSES = 5;
const DELETE_RETRIES = 3;

const settings = definePluginSettings({
    interval: {
        type: OptionType.NUMBER,
        description: "Delay between messages. Minimum is 1000ms.",
        default: DEFAULT_INTERVAL
    },
    maxMessages: {
        type: OptionType.NUMBER,
        description: "Default maximum number of your messages to delete per run.",
        default: MAX_MESSAGES
    }
});

const activeChannels = new Set<string>();
const cancelledChannels = new Set<string>();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function clampInterval(ms?: number) {
    return Math.max(MIN_INTERVAL, Number(ms || settings.store.interval || DEFAULT_INTERVAL));
}

function clampCount(count?: number) {
    return Math.max(1, Math.min(MAX_MESSAGES, Number(count || settings.store.maxMessages || MAX_MESSAGES)));
}

async function deleteMessageWithRetries(channelId: string, messageId: string) {
    let lastError: unknown;

    for (let attempt = 0; attempt < DELETE_RETRIES; attempt++) {
        try {
            await RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, messageId) });
            return true;
        } catch (error) {
            lastError = error;
            await sleep(500 + attempt * 750);
        }
    }

            console.error("[AutoDelete] Failed to delete after retries", lastError);
    return false;
}

async function collectOwnMessages(channelId: string, currentUserId: string, maxMessages: number) {
    const messageIds: string[] = [];
    let before: string | undefined;
    let scanned = 0;

    while (messageIds.length < maxMessages && !cancelledChannels.has(channelId)) {
        const response = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: { limit: 100, ...(before && { before }) }
        });

        const messages = response.body as any[];
        if (!messages?.length) break;

        before = messages[messages.length - 1].id;
        scanned += messages.length;

        for (const message of messages) {
            if (messageIds.length >= maxMessages) break;
            if (message.author?.id !== currentUserId || message.deleted) continue;

            messageIds.push(message.id);
        }

        if (messages.length < 100) break;
        await sleep(250);
    }

    return { messageIds, scanned };
}

async function purgeOwnMessages(channelId: string, maxMessages: number, interval: number) {
    const currentUserId = UserStore.getCurrentUser().id;
    let deleted = 0;
    let failed = 0;
    let scanned = 0;
    let passes = 0;

    while (passes < MAX_PASSES && deleted < maxMessages && !cancelledChannels.has(channelId)) {
        let passDeleted = 0;
        passes++;

        const collected = await collectOwnMessages(channelId, currentUserId, maxMessages - deleted);
        scanned += collected.scanned;
        if (!collected.messageIds.length) break;

        for (const messageId of collected.messageIds) {
            if (deleted >= maxMessages || cancelledChannels.has(channelId)) break;

            try {
                if (!await deleteMessageWithRetries(channelId, messageId)) {
                    throw new Error("Failed to delete message");
                }
                deleted++;
                passDeleted++;
            } catch (error) {
                failed++;
                    console.error("[AutoDelete] Failed to delete message", error);
            }

            if (deleted < maxMessages && !cancelledChannels.has(channelId)) await sleep(interval);
        }

        if (passDeleted === 0) break;
        if (deleted < maxMessages && !cancelledChannels.has(channelId)) await sleep(1500);
    }

    return { deleted, failed, scanned, passes, cancelled: cancelledChannels.has(channelId) };
}

export default definePlugin({
    name: "AutoDelete",
    description: "Automatically deletes your own messages in the current channel with a delay.",
    authors: [{ id: 435847641041993759n, name: "Flarya" }],
    dependencies: ["CommandsAPI"],
    settings,

    commands: [
        {
            name: "clear",
            description: "Delete your own messages in this channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "count",
                    description: "Maximum messages to delete. Default/max is 5k.",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false,
                    minValue: 1,
                    maxValue: MAX_MESSAGES
                },
                {
                    name: "interval",
                    description: "Delay between messages in ms. Minimum 1000, default 1500.",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false,
                    minValue: MIN_INTERVAL,
                    maxValue: 10000
                }
            ],
            execute: (args, ctx) => {
                const channelId = ctx.channel.id;
                if (activeChannels.has(channelId)) {
                    sendBotMessage(channelId, { content: "AutoDelete is already running here. Use `/clearst` to stop it." });
                    return;
                }

                const maxMessages = clampCount(findOption<number>(args, "count"));
                const interval = clampInterval(findOption<number>(args, "interval"));

                activeChannels.add(channelId);
                cancelledChannels.delete(channelId);
                sendBotMessage(channelId, { content: `AutoDelete started: up to ${maxMessages} message(s), ${interval}ms interval.` });

                void purgeOwnMessages(channelId, maxMessages, interval)
                    .then(result => {
                        const status = result.cancelled ? "Stopped" : "Done";
                        sendBotMessage(channelId, {
                            content: `${status}. Deleted ${result.deleted} message(s). Failed ${result.failed}. Scanned ${result.scanned}. Passes ${result.passes}.`
                        });
                    })
                    .catch(error => {
                        console.error("[AutoDelete] Purge failed", error);
                        sendBotMessage(channelId, { content: "AutoDelete failed. Check console for details." });
                    })
                    .finally(() => {
                        activeChannels.delete(channelId);
                        cancelledChannels.delete(channelId);
                    });
            }
        },
        {
            name: "clearst",
            description: "Stop AutoDelete in this channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                cancelledChannels.add(ctx.channel.id);
                sendBotMessage(ctx.channel.id, { content: "Stopping AutoDelete..." });
            }
        }
    ]
});
