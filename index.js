const {
Client,
GatewayIntentBits,
Partials,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
ModalBuilder,
TextInputBuilder,
TextInputStyle,
EmbedBuilder,
PermissionsBitField
} = require("discord.js");

const config = require("./config.json");

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent
],
partials: [Partials.Channel]
});

let suggestionPanelChannel = null;
let suggestionLogChannel = null;

client.once("ready", () => {
console.log(`Logged in as ${client.user.tag}`);
});

/* COMMANDS */
client.on("messageCreate", async (message) => {
if (message.author.bot) return;
if (!message.content.startsWith(config.prefix)) return;

const args = message.content.slice(config.prefix.length).trim().split(/ +/);
const command = args.shift()?.toLowerCase();

if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
return;

// SET PANEL CHANNEL
if (command === "set" && args[0] === "suggestion-channel") {
suggestionPanelChannel = message.channel.id;

const button = new ButtonBuilder()
.setCustomId("open_suggestion_modal")
.setLabel("Submit a suggestion!")
.setStyle(ButtonStyle.Primary);

const row = new ActionRowBuilder().addComponents(button);

await message.channel.send({
content:
"**If you have suggestions that would make the server better, click the submit suggestion button below.**",
components: [row]
});

message.reply("Suggestion panel channel set.");
}

// SET LOG CHANNEL
if (command === "set" && args[0] === "suggestion-log") {
suggestionLogChannel = message.channel.id;
message.reply("Suggestion log channel set.");
}
});

/* INTERACTIONS */
client.on("interactionCreate", async (interaction) => {
/* OPEN MODAL */
if (interaction.isButton() && interaction.customId === "open_suggestion_modal") {
const modal = new ModalBuilder()
.setCustomId("suggestion_modal")
.setTitle("Submit a Suggestion");

const suggestionInput = new TextInputBuilder()
.setCustomId("suggestion_text")
.setLabel("Suggestion Content")
.setStyle(TextInputStyle.Paragraph)
.setRequired(true)
.setMaxLength(4000);

modal.addComponents(new ActionRowBuilder().addComponents(suggestionInput));
await interaction.showModal(modal);
}

/* APPROVE / DENY */
if (interaction.isButton()) {
if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
return interaction.reply({ content: "No permission.", ephemeral: true });
}

const embed = EmbedBuilder.from(interaction.message.embeds[0]);

if (interaction.customId === "approve_suggestion") {
embed.setColor(0x57f287).addFields({
name: "Status",
value: "✅ Approved"
});
}

if (interaction.customId === "deny_suggestion") {
embed.setColor(0xed4245).addFields({
name: "Status",
value: "❌ Denied"
});
}

await interaction.message.edit({
embeds: [embed],
components: []
});

await interaction.reply({ content: "Suggestion updated.", ephemeral: true });
}

/* MODAL SUBMIT */
if (interaction.isModalSubmit() && interaction.customId === "suggestion_modal") {
if (!suggestionLogChannel)
return interaction.reply({
content: "Suggestion log channel not set.",
ephemeral: true
});

const suggestion = interaction.fields.getTextInputValue("suggestion_text");

const embed = new EmbedBuilder()
.setTitle("New Suggestion")
.setDescription(suggestion)
.setColor(0x5865f2)
.addFields({
name: "Submitted by",
value: `${interaction.user.tag} (${interaction.user.id})`
})
.setTimestamp();

const row = new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId("approve_suggestion")
.setLabel("Approve")
.setStyle(ButtonStyle.Success),
new ButtonBuilder()
.setCustomId("deny_suggestion")
.setLabel("Deny")
.setStyle(ButtonStyle.Danger)
);

const channel = await client.channels.fetch(suggestionLogChannel);
await channel.send({ embeds: [embed], components: [row] });

await interaction.reply({
content: "Your suggestion has been submitted.",
ephemeral: true
});
}
});

client.login(config.token);
