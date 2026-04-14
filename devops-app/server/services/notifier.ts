interface NotifyOptions {
  serverId: string;
  event: string;
  details: string;
  botToken?: string;
  chatId?: string;
}

class TelegramNotifier {
  private get defaultToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN || undefined;
  }

  private get defaultChatId(): string | undefined {
    return process.env.TELEGRAM_CHAT_ID || undefined;
  }

  async notify(options: NotifyOptions): Promise<boolean> {
    const token = options.botToken ?? this.defaultToken;
    const chatId = options.chatId ?? this.defaultChatId;

    if (!token || !chatId) {
      console.log("[notifier] Telegram not configured, skipping notification");
      return false;
    }

    const text = `*${options.event}*\nServer: \`${options.serverId}\`\n${options.details}`;

    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "Markdown",
          }),
        },
      );

      if (!resp.ok) {
        console.error(
          `[notifier] Telegram API error: ${resp.status} ${resp.statusText}`,
        );
        return false;
      }

      return true;
    } catch (err) {
      console.error("[notifier] Failed to send Telegram notification:", err);
      return false;
    }
  }
}

export const notifier = new TelegramNotifier();
