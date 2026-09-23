import { z } from "zod";

/** 富邦證券登入設定。機密欄位由 Worker 加密保存。 */
export const fubonsecConfigSchema = z.object({
  userId: z.string().min(1).max(32).optional(),
  account: z.string().min(1).max(128).optional(),
  password: z.string().min(1).max(128).optional(),
});

export type FubonsecConfig = z.infer<typeof fubonsecConfigSchema>;

export class FubonsecConnectorNotImplementedError extends Error {
  constructor() {
    super("富邦證券同步尚未實作；目前只能儲存設定與建立同步排程。");
  }
}

export function parseFubonsecConfig(config: unknown): FubonsecConfig {
  return fubonsecConfigSchema.parse(config);
}
