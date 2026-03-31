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
  PermissionsBitField,
  MessageFlags,
  StringSelectMenuBuilder
} = require("discord.js");

const config = require("./config.json");
const fs = require("fs");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ══════════════════════════════════════════════════════════════
   STATE & CONFIGURATION
   ══════════════════════════════════════════════════════════════ */

let suggestionPanelChannel = null;
let suggestionLogChannel = null;

const COOLDOWN_MS = 60_000; // 60s per-user submission cooldown

const processedInteractions = new Set();
const processedSuggestions = new Map();
const userCooldowns = new Map();
const blacklistedUsers = new Map();
const pendingCategories = new Map();
const suggestionVotes = new Map();       // messageId -> { upvotes: Set, downvotes: Set }
const suggestionMeta = new Map();        // messageId -> full suggestion data object
const pendingStaffActions = new Map();   // messageId -> "approved"|"denied"|"considering"

const stats = { total: 0, approved: 0, denied: 0, considering: 0, pending: 0 };

const BLACKLIST_FILE = "./blacklist.json";

/* ── Category Definitions ── */
const CATEGORIES = [
  { label: "Feature Request", value: "feature",     emoji: "💡", color: 0x5865f2 },
  { label: "Event Idea",      value: "event",       emoji: "🎉", color: 0xfee75c },
  { label: "Rule Change",     value: "rules",       emoji: "📜", color: 0x57f287 },
  { label: "Community / Vibes", value: "community", emoji: "🌿", color: 0xeb459e },
  { label: "Bug Report",      value: "bug",         emoji: "🐛", color: 0xed4245 },
  { label: "Other",           value: "other",       emoji: "📎", color: 0x99aab5 }
];

function getCategoryInfo(value) {
  return CATEGORIES.find(c => c.value === value) || CATEGORIES[CATEGORIES.length - 1];
}

/* ── Persistence ── */
function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
      for (const [id, entry] of Object.entries(data)) {
        blacklistedUsers.set(id, entry);
      }
      console.log(`Loaded ${blacklistedUsers.size} blacklisted users from disk.`);
    }
  } catch (e) {
    console.error("Failed to load blacklist:", e);
  }
}

function saveBlacklist() {
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(Object.fromEntries(blacklistedUsers), null, 2));
  } catch (e) {
    console.error("Failed to save blacklist:", e);
  }
}

loadBlacklist();

/* ── Periodic Cleanup ── */
setInterval(() => processedInteractions.clear(), 600_000);          // 10 min
setInterval(() => processedSuggestions.clear(), 3_600_000);          // 1 hour
setInterval(() => {                                                  // 5 min
  const now = Date.now();
  for (const [id, ts] of userCooldowns) {
    if (now - ts >= COOLDOWN_MS * 2) userCooldowns.delete(id);
  }
}, 300_000);

/* ══════════════════════════════════════════════════════════════
   EMBED & COMPONENT BUILDERS
   ══════════════════════════════════════════════════════════════ */

function buildSuggestionEmbed(data) {
  const cat = getCategoryInfo(data.category);
  const embed = new EmbedBuilder()
    .setTitle(`${cat.emoji} Suggestion — ${cat.label}`)
    .setDescription(data.suggestion)
    .setColor(cat.color)
    .addFields(
      { name: "Category", value: cat.label, inline: true },
      { name: "Submitted by", value: `${data.authorTag} (<@${data.authorId}>)`, inline: true }
    )
    .setTimestamp(data.timestamp || Date.now());

  // Status field
  if (data.status && data.status !== "pending") {
    const statusConfig = {
      approved:    { emoji: "✅", label: "Approved" },
      denied:      { emoji: "❌", label: "Denied" },
      considering: { emoji: "💭", label: "Considering" }
    };
    const sc = statusConfig[data.status];
    if (sc) {
      embed.addFields({
        name: "Status",
        value: `${sc.emoji} ${sc.label}${data.reason ? `\n*${data.reason}*` : ""}`
      });
      embed.setColor(data.status === "approved" ? 0x57f287 :
                     data.status === "denied" ? 0xed4245 : 0xfee75c);
    }
  }

  // Vote counts
  if (data.upvotes !== undefined) {
    embed.addFields({
      name: "Community Votes",
      value: `👍 **${data.upvotes}**  |  👎 **${data.downvotes}**`,
      inline: true
    });
  }

  // Staff comments
  if (data.comments && data.comments.length > 0) {
    const commentLines = data.comments.map(c =>
      `**${c.author}** (${new Date(c.timestamp).toLocaleDateString()}): ${c.text}`
    );
    embed.addFields({
      name: `💬 Staff Comments (${data.comments.length})`,
      value: commentLines.join("\n\n")
    });
  }

  return embed;
}

function buildVoteRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sug_upvote").setLabel("👍 Upvote").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("sug_downvote").setLabel("👎 Downvote").setStyle(ButtonStyle.Danger)
  );
}

function buildStaffRow(isFinalized) {
  const components = [];
  if (!isFinalized) {
    components.push(
      new ButtonBuilder().setCustomId("sug_consider").setLabel("💭 Consider").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("sug_approve").setLabel("✅ Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("sug_deny").setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
    );
  }
  components.push(
    new ButtonBuilder().setCustomId("sug_comment").setLabel("💬 Comment").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("sug_edit").setLabel("✏️ Edit").setStyle(ButtonStyle.Secondary)
  );
  return new ActionRowBuilder().addComponents(components);
}

function buildCombinedRows(isFinalized) {
  return [buildVoteRow(), buildStaffRow(isFinalized)];
}

/* ══════════════════════════════════════════════════════════════
   COMMANDS
   ══════════════════════════════════════════════════════════════ */

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift()?.toLowerCase();

  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

  // ── SET PANEL CHANNEL ──
  if (command === "set" && args[0] === "suggestion-channel") {
    suggestionPanelChannel = message.channel.id;

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("suggestion_category")
      .setPlaceholder("Choose a category...")
      .addOptions(
        CATEGORIES.map(c => ({
          label: c.label,
          value: c.value,
          description: `Submit a ${c.label.toLowerCase()}`,
          emoji: c.emoji
        }))
      );

    const button = new ButtonBuilder()
      .setCustomId("open_suggestion_modal")
      .setLabel("Submit a suggestion!")
      .setStyle(ButtonStyle.Primary);

    await message.channel.send({
      content:
        "**This server is shaped by its community, not just its staff.**\n" +
        "If you have a suggestion that could improve anything here — features, events, rules, or vibes — submit it below.\n" +
        "Your ideas directly influence how the server grows.\n\n" +
        "📌 **How it works:**\n" +
        "1. Pick a category from the dropdown\n" +
        "2. Click **Submit a suggestion!**\n" +
        "3. Write your idea and hit send\n\n" +
        "_You can submit once every 60 seconds. Staff can vote, comment, and review your idea!_",
      components: [
        new ActionRowBuilder().addComponents(selectMenu),
        new ActionRowBuilder().addComponents(button)
      ]
    });

    message.reply("Suggestion panel channel set.");
  }

  // ── SET LOG CHANNEL ──
  if (command === "set" && args[0] === "suggestion-log") {
    suggestionLogChannel = message.channel.id;
    message.reply("Log Channel set ✅");
  }

  // ── BLACKLIST USER ──
  if (command === "blacklist-user") {
    if (!args[0]) return message.reply("Usage: `!blacklist-user <userId> [reason]`");
    const userId = args[0];
    const reason = args.slice(1).join(" ") || "No reason provided";
    blacklistedUsers.set(userId, {
      reason,
      date: new Date().toISOString(),
      blacklistedBy: message.author.tag
    });
    saveBlacklist();
    message.reply(`User \`${userId}\` has been blacklisted from submitting suggestions.\n**Reason:** ${reason}`);
  }

  // ── UNBLACKLIST USER ──
  if (command === "unblacklist-user") {
    if (!args[0]) return message.reply("Usage: `!unblacklist-user <userId>`");
    const userId = args[0];
    if (!blacklistedUsers.has(userId)) return message.reply("That user is not blacklisted.");
    blacklistedUsers.delete(userId);
    saveBlacklist();
    message.reply(`User \`${userId}\` has been unblacklisted. ✅`);
  }

  // ── VIEW BLACKLIST ──
  if (command === "blacklist") {
    if (blacklistedUsers.size === 0) return message.reply("No blacklisted users.");
    const embed = new EmbedBuilder()
      .setTitle("🚫 Blacklisted Users")
      .setDescription(
        Array.from(blacklistedUsers.entries())
          .map(([id, d]) => `• \`${id}\` — **${d.reason}** (by ${d.blacklistedBy}, ${d.date})`)
          .join("\n")
      )
      .setColor(0xed4245);
    message.reply({ embeds: [embed] });
  }

  // ── SUGGESTION STATS ──
  if (command === "suggestion-stats") {
    const embed = new EmbedBuilder()
      .setTitle("📊 Suggestion Statistics")
      .setColor(0x5865f2)
      .addFields(
        { name: "Total Submitted",    value: `${stats.total}`,       inline: true },
        { name: "⏳ Pending",          value: `${stats.pending}`,     inline: true },
        { name: "💭 Considering",      value: `${stats.considering}`, inline: true },
        { name: "✅ Approved",         value: `${stats.approved}`,    inline: true },
        { name: "❌ Denied",           value: `${stats.denied}`,      inline: true },
        { name: "🚫 Blacklisted",      value: `${blacklistedUsers.size}`, inline: true }
      )
      .setFooter({ text: `Tracking ${suggestionVotes.size} active suggestions` })
      .setTimestamp();
    message.reply({ embeds: [embed] });
  }
});

/* ══════════════════════════════════════════════════════════════
   INTERACTION HANDLER
   ══════════════════════════════════════════════════════════════ */

client.on("interactionCreate", async (interaction) => {
  if (processedInteractions.has(interaction.id)) return;

  try {

    /* ─────────── CATEGORY SELECT MENU ─────────── */
    if (interaction.isStringSelectMenu() && interaction.customId === "suggestion_category") {
      processedInteractions.add(interaction.id);
      const selected = interaction.values[0];
      const cat = getCategoryInfo(selected);
      pendingCategories.set(interaction.user.id, selected);
      await interaction.reply({
        content: `Category set to **${cat.label}** ${cat.emoji} — Now click **Submit a suggestion!** to continue.`,
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    /* ─────────── OPEN SUGGESTION MODAL ─────────── */
    if (interaction.isButton() && interaction.customId === "open_suggestion_modal") {
      processedInteractions.add(interaction.id);

      const modal = new ModalBuilder()
        .setCustomId("suggestion_modal")
        .setTitle("Submit a Suggestion");

      const suggestionInput = new TextInputBuilder()
        .setCustomId("suggestion_text")
        .setLabel("Suggestion Content")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setPlaceholder("Describe your suggestion in detail. The more context, the better!");

      modal.addComponents(new ActionRowBuilder().addComponents(suggestionInput));
      await interaction.showModal(modal);
      return;
    }

    /* ─────────── STAFF: APPROVE / DENY / CONSIDER → opens reason modal ─────────── */
    if (interaction.isButton() && ["sug_approve", "sug_deny", "sug_consider"].includes(interaction.customId)) {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: "No permission.", flags: [MessageFlags.Ephemeral] });
      }
      if (!interaction.message.embeds[0]) return;
      processedInteractions.add(interaction.id);

      const meta = suggestionMeta.get(interaction.message.id);
      if (meta && (meta.status === "approved" || meta.status === "denied")) {
        return interaction.reply({
          content: "This suggestion has already been finalized.",
          flags: [MessageFlags.Ephemeral]
        });
      }

      const actionMap = { sug_approve: "approved", sug_deny: "denied", sug_consider: "considering" };
      const labelMap = { approved: "Approve", denied: "Deny", considering: "Mark as Considering" };
      const action = actionMap[interaction.customId];

      // Store the action so the modal submit handler knows what to do
      pendingStaffActions.set(interaction.message.id, action);

      const modal = new ModalBuilder()
        .setCustomId(`staff_reason_${interaction.message.id}`)
        .setTitle(`${labelMap[action]} Suggestion`);

      const reasonInput = new TextInputBuilder()
        .setCustomId("staff_reason")
        .setLabel("Reason (optional)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000)
        .setPlaceholder(`Why are you ${labelMap[action].toLowerCase()}ing this suggestion?`);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
      return;
    }

    /* ─────────── STAFF: COMMENT → opens comment modal ─────────── */
    if (interaction.isButton() && interaction.customId === "sug_comment") {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: "No permission.", flags: [MessageFlags.Ephemeral] });
      }
      processedInteractions.add(interaction.id);

      const modal = new ModalBuilder()
        .setCustomId(`staff_comment_${interaction.message.id}`)
        .setTitle("💬 Add Staff Comment");

      const commentInput = new TextInputBuilder()
        .setCustomId("comment_text")
        .setLabel("Comment")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
        .setPlaceholder("Write your feedback or question about this suggestion...");

      modal.addComponents(new ActionRowBuilder().addComponents(commentInput));
      await interaction.showModal(modal);
      return;
    }

    /* ─────────── STAFF: EDIT → opens edit modal ─────────── */
    if (interaction.isButton() && interaction.customId === "sug_edit") {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: "No permission.", flags: [MessageFlags.Ephemeral] });
      }
      processedInteractions.add(interaction.id);

      const currentText = interaction.message.embeds[0]?.description || "";

      const modal = new ModalBuilder()
        .setCustomId(`staff_edit_${interaction.message.id}`)
        .setTitle("✏️ Edit Suggestion");

      const editInput = new TextInputBuilder()
        .setCustomId("edit_text")
        .setLabel("New Suggestion Content")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setValue(currentText.length <= 4000 ? currentText : currentText.slice(0, 4000))
        .setPlaceholder("Edit the suggestion content...");

      modal.addComponents(new ActionRowBuilder().addComponents(editInput));
      await interaction.showModal(modal);
      return;
    }

    /* ─────────── COMMUNITY VOTING ─────────── */
    if (interaction.isButton() && ["sug_upvote", "sug_downvote"].includes(interaction.customId)) {
      processedInteractions.add(interaction.id);
      const messageId = interaction.message.id;
      const userId = interaction.user.id;
      const isUpvote = interaction.customId === "sug_upvote";

      if (!suggestionVotes.has(messageId)) {
        suggestionVotes.set(messageId, { upvotes: new Set(), downvotes: new Set() });
      }

      const votes = suggestionVotes.get(messageId);
      const meta = suggestionMeta.get(messageId);
      if (!meta) return;

      // Toggle behavior: remove existing vote, add if not a repeat click
      const wasUpvoted = votes.upvotes.has(userId);
      const wasDownvoted = votes.downvotes.has(userId);

      votes.upvotes.delete(userId);
      votes.downvotes.delete(userId);

      // Only add the vote if the user wasn't already voting the same way (toggle off)
      if (isUpvote && !wasUpvoted) votes.upvotes.add(userId);
      else if (!isUpvote && !wasDownvoted) votes.downvotes.add(userId);

      // Rebuild the embed with updated vote counts
      const updatedEmbed = buildSuggestionEmbed({
        ...meta,
        upvotes: votes.upvotes.size,
        downvotes: votes.downvotes.size
      });

      const isFinalized = meta.status === "approved" || meta.status === "denied";
      await interaction.message.edit({
        embeds: [updatedEmbed],
        components: buildCombinedRows(isFinalized)
      });

      const state = isUpvote
        ? (wasUpvoted ? "removed your upvote" : "upvoted")
        : (wasDownvoted ? "removed your downvote" : "downvoted");

      await interaction.reply({
        content: `👍 You ${state}! (👍 ${votes.upvotes.size} | 👎 ${votes.downvotes.size})`,
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    /* ═══════════ MODAL SUBMISSIONS ═══════════ */

    /* ─────────── SUGGESTION SUBMISSION ─────────── */
    if (interaction.isModalSubmit() && interaction.customId === "suggestion_modal") {
      if (processedInteractions.has(interaction.id)) return;
      processedInteractions.add(interaction.id);

      const suggestion = interaction.fields.getTextInputValue("suggestion_text");

      // Blacklist check
      if (blacklistedUsers.has(interaction.user.id)) {
        const bl = blacklistedUsers.get(interaction.user.id);
        return interaction.reply({
          content: `You are blacklisted from submitting suggestions.\n**Reason:** ${bl.reason}`,
          flags: [MessageFlags.Ephemeral]
        });
      }

      // Cooldown check
      const lastSubmission = userCooldowns.get(interaction.user.id);
      if (lastSubmission) {
        const remaining = COOLDOWN_MS - (Date.now() - lastSubmission);
        if (remaining > 0) {
          return interaction.reply({
            content: `Please wait **${Math.ceil(remaining / 1000)}** seconds before submitting another suggestion.`,
            flags: [MessageFlags.Ephemeral]
          });
        }
      }

      // Duplicate check
      const suggestionKey = `${interaction.user.id}:${suggestion}`;
      if (processedSuggestions.has(suggestionKey)) {
        return interaction.reply({
          content: "You've already submitted this exact suggestion! Please modify it or wait.",
          flags: [MessageFlags.Ephemeral]
        });
      }
      processedSuggestions.set(suggestionKey, Date.now());

      if (!suggestionLogChannel) {
        return interaction.reply({
          content: "Suggestion system is not configured yet. Please contact an admin.",
          flags: [MessageFlags.Ephemeral]
        });
      }

      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      // Get category from selection (default to "other")
      const category = pendingCategories.get(interaction.user.id) || "other";
      pendingCategories.delete(interaction.user.id);

      const now = Date.now();
      const suggestionData = {
        suggestion,
        authorId: interaction.user.id,
        authorTag: interaction.user.tag,
        category,
        status: "pending",
        reason: null,
        comments: [],
        upvotes: 0,
        downvotes: 0,
        timestamp: now
      };

      const embed = buildSuggestionEmbed(suggestionData);
      const channel = await client.channels.fetch(suggestionLogChannel).catch(() => null);

      if (channel) {
        const sentMessage = await channel.send({
          embeds: [embed],
          components: buildCombinedRows(false)
        });

        // Track metadata and votes by the log message ID
        suggestionMeta.set(sentMessage.id, { ...suggestionData, messageId: sentMessage.id });
        suggestionVotes.set(sentMessage.id, { upvotes: new Set(), downvotes: new Set() });

        // Update state
        userCooldowns.set(interaction.user.id, now);
        stats.total++;
        stats.pending++;

        await interaction.editReply({
          content: "Your suggestion has been submitted successfully! 🎉 You'll be notified when staff reviews it."
        });
      } else {
        await interaction.editReply({
          content: "Error: Could not find the suggestion log channel. Please contact an admin."
        });
      }
      return;
    }

    /* ─────────── STAFF REASON SUBMIT (approve/deny/consider) ─────────── */
    if (interaction.isModalSubmit() && interaction.customId.startsWith("staff_reason_")) {
      if (processedInteractions.has(interaction.id)) return;
      processedInteractions.add(interaction.id);

      const messageId = interaction.customId.replace("staff_reason_", "");
      const reason = interaction.fields.getTextInputValue("staff_reason") || null;

      const meta = suggestionMeta.get(messageId);
      if (!meta) {
        return interaction.reply({
          content: "Could not find suggestion data. It may have been deleted.",
          flags: [MessageFlags.Ephemeral]
        });
      }

      const action = pendingStaffActions.get(messageId);
      if (!action) {
        return interaction.reply({
          content: "Session expired. Please try the action again.",
          flags: [MessageFlags.Ephemeral]
        });
      }
      pendingStaffActions.delete(messageId);

      // Update stats
      if (meta.status === "pending") stats.pending--;
      else if (meta.status === "considering") stats.considering--;

      meta.status = action;
      meta.reason = reason;
      suggestionMeta.set(messageId, meta);

      if (action === "approved") stats.approved++;
      else if (action === "denied") stats.denied++;
      else if (action === "considering") stats.considering++;

      // Rebuild embed with new status
      const votes = suggestionVotes.get(messageId);
      const updatedEmbed = buildSuggestionEmbed({
        ...meta,
        upvotes: votes ? votes.upvotes.size : 0,
        downvotes: votes ? votes.downvotes.size : 0
      });

      const isFinalized = action === "approved" || action === "denied";
      await interaction.message.edit({
        embeds: [updatedEmbed],
        components: buildCombinedRows(isFinalized)
      });

      // DM the suggestion author
      try {
        const user = await client.users.fetch(meta.authorId);
        const statusConfig = {
          approved: "✅ Approved",
          denied: "❌ Denied",
          considering: "💭 Being Considered"
        };
        let dmContent = `Your suggestion has been updated: **${statusConfig[action]}**`;
        if (reason) dmContent += `\n**Staff Reason:** ${reason}`;
        dmContent += `\n\n*You submitted:* "${meta.suggestion.slice(0, 100)}${meta.suggestion.length > 100 ? "..." : ""}"`;
        await user.send(dmContent).catch(() => {});
      } catch (e) {
        console.error("Failed to send DM:", e);
      }

      const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
      await interaction.reply({
        content: `Suggestion marked as **${actionLabel}**.${reason ? ` Reason: ${reason}` : ""}`,
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    /* ─────────── STAFF COMMENT SUBMIT ─────────── */
    if (interaction.isModalSubmit() && interaction.customId.startsWith("staff_comment_")) {
      if (processedInteractions.has(interaction.id)) return;
      processedInteractions.add(interaction.id);

      const messageId = interaction.customId.replace("staff_comment_", "");
      const commentText = interaction.fields.getTextInputValue("comment_text");

      const meta = suggestionMeta.get(messageId);
      if (!meta) {
        return interaction.reply({
          content: "Could not find suggestion data.",
          flags: [MessageFlags.Ephemeral]
        });
      }

      if (!meta.comments) meta.comments = [];
      meta.comments.push({
        author: interaction.user.tag,
        text: commentText,
        timestamp: new Date().toISOString()
      });
      suggestionMeta.set(messageId, meta);

      // Rebuild embed
      const votes = suggestionVotes.get(messageId);
      const updatedEmbed = buildSuggestionEmbed({
        ...meta,
        upvotes: votes ? votes.upvotes.size : 0,
        downvotes: votes ? votes.downvotes.size : 0
      });

      const isFinalized = meta.status === "approved" || meta.status === "denied";
      await interaction.message.edit({
        embeds: [updatedEmbed],
        components: buildCombinedRows(isFinalized)
      });

      // Notify the suggestion author
      try {
        const user = await client.users.fetch(meta.authorId);
        await user.send(
          `💬 A staff member commented on your suggestion:\n` +
          `**${interaction.user.tag}**: ${commentText}`
        ).catch(() => {});
      } catch (e) {
        console.error("Failed to send comment DM:", e);
      }

      await interaction.reply({
        content: "Comment added to the suggestion! ✅",
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    /* ─────────── STAFF EDIT SUBMIT ─────────── */
    if (interaction.isModalSubmit() && interaction.customId.startsWith("staff_edit_")) {
      if (processedInteractions.has(interaction.id)) return;
      processedInteractions.add(interaction.id);

      const messageId = interaction.customId.replace("staff_edit_", "");
      const newText = interaction.fields.getTextInputValue("edit_text");

      const meta = suggestionMeta.get(messageId);
      if (!meta) {
        return interaction.reply({
          content: "Could not find suggestion data.",
          flags: [MessageFlags.Ephemeral]
        });
      }

      meta.suggestion = newText;
      suggestionMeta.set(messageId, meta);

      // Rebuild embed
      const votes = suggestionVotes.get(messageId);
      const updatedEmbed = buildSuggestionEmbed({
        ...meta,
        upvotes: votes ? votes.upvotes.size : 0,
        downvotes: votes ? votes.downvotes.size : 0
      });

      const isFinalized = meta.status === "approved" || meta.status === "denied";
      await interaction.message.edit({
        embeds: [updatedEmbed],
        components: buildCombinedRows(isFinalized)
      });

      await interaction.reply({
        content: "Suggestion content edited! ✅",
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

  } catch (error) {
    console.error("Interaction error:", error);
    if (interaction.isRepliable()) {
      try {
        await interaction.followUp({
          content: "An error occurred while processing this interaction.",
          flags: [MessageFlags.Ephemeral]
        });
      } catch (_) { /* silent */ }
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   READY
   ══════════════════════════════════════════════════════════════ */

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Commands: set suggestion-channel, set suggestion-log, blacklist-user, unblacklist-user, blacklist, suggestion-stats`);
});

client.login("MTQ1Nzg2NDU1NDY2NjAwNDY3Nw.Goj1pW.CWgAXWd1Wcl_XFus7ZgkaRL3PDFFoJPZvFKcDY");
