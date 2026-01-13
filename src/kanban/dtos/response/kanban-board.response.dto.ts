export class KanbanItemResponseDto {
  _id: string;
  userId: string;
  provider: 'gmail';
  messageId: string;
  mailboxId?: string;

  unread?: boolean;

  senderName?: string;
  senderEmail?: string;
  subject?: string;
  snippet?: string;
  threadId?: string;

  status: string;
  originalStatus?: string;
  snoozeUntil?: string;

  summary?: string;
  lastSummarizedAt?: string;

  receivedAt?: string; // Email date from Gmail (internalDate)

  hasAttachments?: boolean;

  createdAt?: string;
  updatedAt?: string;

  static fromEmailItem(item: any): KanbanItemResponseDto {
    const toIso = (d: any) => {
      if (!d) return undefined;
      const date = d instanceof Date ? d : new Date(d);
      return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
    };

    return {
      _id: String(item?._id ?? ''),
      userId: String(item?.userId ?? ''),
      provider: (item?.provider as 'gmail') ?? 'gmail',
      messageId: String(item?.messageId ?? item?.id ?? ''),
      mailboxId: item?.mailboxId,

      unread: item?.unread,

      senderName: item?.senderName,
      senderEmail: item?.senderEmail,
      subject: item?.subject,
      snippet: item?.snippet,
      threadId: item?.threadId,

      status: String(item?.status ?? ''),
      originalStatus: item?.originalStatus,
      snoozeUntil: toIso(item?.snoozeUntil),

      summary: item?.summary,
      lastSummarizedAt: toIso(item?.lastSummarizedAt),

      receivedAt: toIso(item?.receivedAt),

      hasAttachments: item?.hasAttachments,

      createdAt: toIso(item?.createdAt),
      updatedAt: toIso(item?.updatedAt),
    };
  }
}

export class KanbanColumnDataDto {
  [columnId: string]: KanbanItemResponseDto[];
}

export class KanbanMetaDto {
  pageSize: number;
  nextPageToken?: string;
  hasMore: boolean;
  total: Record<string, number>;
}

export class KanbanWarningDto {
  columnId: string;
  message: string;
  type: string;
}

export class KanbanBoardResponseDto {
  data: KanbanColumnDataDto;
  meta: KanbanMetaDto;
  columns: any[];
  warnings?: KanbanWarningDto[];

  static create(serviceResult: any): KanbanBoardResponseDto {
    // Transform data: convert items in each column to DTOs
    const transformedData: KanbanColumnDataDto = {};
    for (const [columnId, items] of Object.entries(serviceResult.data)) {
      transformedData[columnId] = (items as any[]).map((item) =>
        KanbanItemResponseDto.fromEmailItem(item),
      );
    }

    return {
      data: transformedData,
      meta: serviceResult.meta,
      columns: serviceResult.columns,
      warnings: serviceResult.warnings,
    };
  }
}
