export interface UploadOwnerFields {
  userId?: unknown;
  sessionId?: unknown;
}

export interface UploadViewer {
  userId: string;
  sessionId: string;
}

/**
 * A persisted user owner is authoritative. The storage session scope only
 * grants access to legacy or anonymous records that have no user owner;
 * otherwise a reused browser session could expose another user's upload.
 */
export function ownsUpload(
  record: UploadOwnerFields,
  viewer: UploadViewer,
): boolean {
  if (record.userId) return record.userId === viewer.userId;
  return Boolean(record.sessionId) && record.sessionId === viewer.sessionId;
}
