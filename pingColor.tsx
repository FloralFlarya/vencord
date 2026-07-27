import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

function hex(v: string) {
    return v.startsWith("#") ? v : `#${v}`;
}

function applyStyles() {
    document.getElementById("vc-ping-color-styles")?.remove();

    const s = settings.store;
    const mc = hex(s.mentionColor);
    const mb = hex(s.mentionBarColor);
    const rc = hex(s.replyColor);
    const rb = hex(s.replyBarColor);

    const style = document.createElement("style");
    style.id = "vc-ping-color-styles";

    style.textContent = `
[class*="mentioned_"][class*="gradient_"][class*="wrapper_"][class*="message_"][class*="cozy"] {
    background-image: linear-gradient(to right, color-mix(in hsl, ${mc}, transparent 90%) 40%, transparent) !important;
    background-color: transparent !important;
}
[class*="mentioned_"][class*="gradient_"][class*="wrapper_"][class*="message_"][class*="cozy"]:hover {
    background-image: linear-gradient(to right, color-mix(in hsl, ${mc}, transparent 85%) 40%, transparent) !important;
    background-color: transparent !important;
}
[class*="mentioned_"]::before {
    background-color: ${mb} !important;
}

[class*="replying_"][class*="gradient_"] {
    background-image: linear-gradient(to right, color-mix(in hsl, ${rc}, transparent 90%) 40%, transparent) !important;
}
[class*="replying_"][class*="gradient_"]:hover {
    background-image: linear-gradient(to right, color-mix(in hsl, ${rc}, transparent 85%) 40%, transparent) !important;
}
[class*="replying_"]::before {
    background-color: ${rb} !important;
}
`;

    document.body.appendChild(style);
}

const settings = definePluginSettings({
    mentionColor: {
        type: OptionType.STRING,
        description: "Background color for @mention messages (hex without #, e.g. f38ba8)",
        default: "f38ba8",
        onChange: applyStyles,
    },
    mentionBarColor: {
        type: OptionType.STRING,
        description: "Left bar color for @mention messages",
        default: "f38ba8",
        onChange: applyStyles,
    },
    replyColor: {
        type: OptionType.STRING,
        description: "Background color for reply messages",
        default: "cdd6f4",
        onChange: applyStyles,
    },
    replyBarColor: {
        type: OptionType.STRING,
        description: "Left bar color for reply messages",
        default: "cdd6f4",
        onChange: applyStyles,
    },
});

export default definePlugin({
    name: "PingColor",
    description: "Customize the colors of mention/reply backgrounds and left bars in Discord",
    authors: [{ id: 435847641041993759n, name: "Flarya" }],
    settings,

    start() {
        applyStyles();
    },

    stop() {
        document.getElementById("vc-ping-color-styles")?.remove();
    },
});
