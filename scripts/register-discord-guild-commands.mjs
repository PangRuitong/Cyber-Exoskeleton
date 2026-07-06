import { existsSync, readFileSync } from "node:fs";

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    process.env[name] ??= value.replace(/^['"]|['"]$/g, "");
  }
}

loadDotEnv(".env");

const applicationId = process.env.APPLICATION_ID ?? "1523775407478935582";
const guildId = process.env.DISCORD_SERVER_ID ?? "1523771948666982501";
const botToken = process.env.DISCORD_BOT_TOKEN ?? "";

const commands = [
  {
    name: "save",
    description: "Save a thought",
    type: 1,
    options: [
      {
        name: "text",
        description: "Thought text to save",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "search",
    description: "Search saved thoughts",
    type: 1,
    options: [
      {
        name: "query",
        description: "Search query",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "recent",
    description: "Show recent thoughts",
    type: 1,
  },
];

if (!botToken) {
  throw new Error("DISCORD_BOT_TOKEN is required in the environment");
}

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
  {
    method: "PUT",
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(commands),
  },
);

const responseBody = await response.text();

if (!response.ok) {
  throw new Error(
    `Discord command registration failed: ${response.status} ${responseBody}`,
  );
}

console.log(responseBody);
