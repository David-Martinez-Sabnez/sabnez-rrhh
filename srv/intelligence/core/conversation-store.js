"use strict";

const cds = require("@sap/cds");
const { randomUUID } = require("node:crypto");

const CONVERSATIONS = "sabnez.intelligence.Conversations";
const MESSAGES = "sabnez.intelligence.Messages";

function safeJson(value) {
  if (value === undefined || value === null) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

class ConversationStore {
  constructor({ historyLimit = 20 } = {}) {
    this.historyLimit = historyLimit;
  }

  async resolveConversation({
    tx,
    conversationId,
    user,
    context = {},
  }) {
    if (!tx) {
      throw new TypeError(
        "ConversationStore requiere una transacción CAP.",
      );
    }

    const userId = this._resolveUserId(user);

    if (conversationId) {
      const existing = await tx.run(
        SELECT.one
          .from(CONVERSATIONS)
          .where({
            ID: conversationId,
            userId,
          }),
      );

      if (existing) {
        await tx.run(
          UPDATE(CONVERSATIONS)
            .set({
              lastContext: safeJson(context),
              lastMessageAt: new Date().toISOString(),
            })
            .where({ ID: conversationId }),
        );

        return existing;
      }
    }

    const ID = conversationId || randomUUID();

    const conversation = {
      ID,
      userId,
      status: "ACTIVE",
      activeGoal: null,
      pendingQuestion: null,
      knownArguments: safeJson({}),
      lastContext: safeJson(context),
      lastMessageAt: new Date().toISOString(),
    };

    await tx.run(
      INSERT.into(CONVERSATIONS).entries(conversation),
    );

    return conversation;
  }

  async appendMessage({
    tx,
    conversationId,
    user,
    role,
    content,
    responseType = null,
    toolName = null,
    toolArguments = null,
    toolResult = null,
    provider = null,
    model = null,
    usage = {},
    context = null,
    payload = null,
  }) {
    const message = {
      ID: randomUUID(),
      conversation_ID: conversationId,
      userId: this._resolveUserId(user),
      role,
      content: String(content || ""),
      responseType,
      toolName,
      toolArguments: safeJson(toolArguments),
      toolResult: safeJson(toolResult),
      provider,
      model,
      inputTokens: Number(usage.inputTokens || 0),
      outputTokens: Number(usage.outputTokens || 0),
      totalTokens: Number(usage.totalTokens || 0),
      appContext: safeJson(context),
      payload: safeJson(payload),
    };

    await tx.run(
      INSERT.into(MESSAGES).entries(message),
    );

    await tx.run(
      UPDATE(CONVERSATIONS)
        .set({
          lastMessageAt: new Date().toISOString(),
          lastContext: safeJson(context),
          lastProvider: provider,
          lastProviderResponseId:
            payload?.provider?.metadata?.responseId || null,
        })
        .where({ ID: conversationId }),
    );

    return message;
  }

  async getHistory({
    tx,
    conversationId,
    user,
    limit = this.historyLimit,
  }) {
    const userId = this._resolveUserId(user);

    const rows = await tx.run(
      SELECT.from(MESSAGES)
        .columns(
          "ID",
          "role",
          "content",
          "responseType",
          "toolName",
          "toolArguments",
          "toolResult",
          "provider",
          "model",
          "createdAt",
        )
        .where({
          conversation_ID: conversationId,
          userId,
        })
        .orderBy("createdAt desc")
        .limit(limit),
    );

    return rows
      .reverse()
      .map((row) => ({
        ...row,
        toolArguments: parseJson(row.toolArguments),
        toolResult: parseJson(row.toolResult),
      }));
  }

  async updateState({
    tx,
    conversationId,
    activeGoal,
    pendingQuestion,
    knownArguments,
  }) {
    await tx.run(
      UPDATE(CONVERSATIONS)
        .set({
          activeGoal: activeGoal || null,
          pendingQuestion: pendingQuestion || null,
          knownArguments: safeJson(knownArguments || {}),
        })
        .where({ ID: conversationId }),
    );
  }

  async getState({
    tx,
    conversationId,
    user,
  }) {
    const row = await tx.run(
      SELECT.one
        .from(CONVERSATIONS)
        .where({
          ID: conversationId,
          userId: this._resolveUserId(user),
        }),
    );

    if (!row) {
      return null;
    }

    return {
      activeGoal: row.activeGoal || null,
      pendingQuestion: row.pendingQuestion || null,
      knownArguments: parseJson(
        row.knownArguments,
        {},
      ),
      lastContext: parseJson(
        row.lastContext,
        {},
      ),
    };
  }

  _resolveUserId(user) {
    return (
      user?.id ||
      user?.attr?.email ||
      user?.attr?.mail ||
      "anonymous"
    );
  }
}

module.exports = {
  ConversationStore,
};
