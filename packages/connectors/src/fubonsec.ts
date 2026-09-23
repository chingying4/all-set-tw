import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  Connector,
  InvestmentPosition,
  InvestmentTransaction,
  NetWorthHistoryPoint,
} from "@taiwan-fin-hub/core";
import { z } from "zod";

const fubonsecAssetTypeSchema = z
  .enum(["stock", "etf", "fund", "bond", "unknown"])
  .default("stock");

const fubonsecHoldingSchema = z.object({
  accountId: z.string().min(1).optional(),
  brokerNo: z.string().min(1).optional(),
  brokerAccount: z.string().min(1).optional(),
  brokerName: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  name: z.string().min(1),
  assetType: fubonsecAssetTypeSchema,
  quantity: z.union([z.string(), z.number()]),
  marketValue: z.union([z.string(), z.number()]).optional(),
  currency: z.string().min(1).default("TWD"),
  asOfDate: z.string().min(1),
  raw: z.unknown().optional(),
});

const fubonsecTradeSchema = z.object({
  accountId: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  brokerNo: z.string().min(1).optional(),
  brokerAccount: z.string().min(1).optional(),
  brokerName: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  assetType: fubonsecAssetTypeSchema.optional(),
  tradeDate: z.string().min(1).optional(),
  postedDate: z.string().min(1).optional(),
  transactionCode: z.string().min(1).optional(),
  transactionName: z.string().min(1).optional(),
  quantity: z.union([z.string(), z.number()]).optional(),
  price: z.union([z.string(), z.number()]).optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  currency: z.string().min(1).default("TWD"),
  raw: z.unknown().optional(),
});

const fubonsecSettlementBalanceSchema = z.object({
  accountId: z.string().min(1).optional(),
  brokerNo: z.string().min(1).optional(),
  brokerAccount: z.string().min(1).optional(),
  brokerName: z.string().min(1).optional(),
  bankCode: z.string().min(1).optional(),
  bankAccount: z.string().min(1).optional(),
  balance: z.union([z.string(), z.number()]),
  availableBalance: z.union([z.string(), z.number()]).optional(),
  currency: z.string().min(1).default("TWD"),
  asOfAt: z.string().min(1),
  raw: z.unknown().optional(),
});

const fubonsecSettlementMovementSchema = z.object({
  accountId: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  brokerNo: z.string().min(1).optional(),
  brokerAccount: z.string().min(1).optional(),
  brokerName: z.string().min(1).optional(),
  bankCode: z.string().min(1).optional(),
  bankAccount: z.string().min(1).optional(),
  postedDate: z.string().min(1).optional(),
  authorizedAt: z.string().min(1).optional(),
  amount: z.union([z.string(), z.number()]),
  currency: z.string().min(1).default("TWD"),
  description: z.string().min(1).optional(),
  counterparty: z.string().min(1).optional(),
  raw: z.unknown().optional(),
});

/** 富邦證券登入設定與標準化資料。機密欄位由 Worker 加密保存。 */
export const fubonsecConfigSchema = z.object({
  userId: z.string().min(1).max(32).optional(),
  account: z.string().min(1).max(128).optional(),
  password: z.string().min(1).max(128).optional(),
  holdings: z.array(fubonsecHoldingSchema).default([]),
  trades: z.array(fubonsecTradeSchema).default([]),
  settlementBalances: z.array(fubonsecSettlementBalanceSchema).default([]),
  settlementMovements: z.array(fubonsecSettlementMovementSchema).default([]),
});

export type FubonsecConfig = z.infer<typeof fubonsecConfigSchema>;
export type FubonsecHolding = FubonsecConfig["holdings"][number];
export type FubonsecTrade = FubonsecConfig["trades"][number];
export type FubonsecSettlementBalance =
  FubonsecConfig["settlementBalances"][number];
export type FubonsecSettlementMovement =
  FubonsecConfig["settlementMovements"][number];

export interface FubonsecClient {
  fetchHoldings(): Promise<FubonsecHolding[]>;
  fetchTrades(): Promise<FubonsecTrade[]>;
  fetchSettlementBalances(): Promise<FubonsecSettlementBalance[]>;
  fetchSettlementMovements(): Promise<FubonsecSettlementMovement[]>;
}

export class FubonsecConnectorNotImplementedError extends Error {
  constructor() {
    super("富邦證券同步尚未實作；目前只能儲存設定與建立同步排程。");
    this.name = "FubonsecConnectorNotImplementedError";
  }
}

export function parseFubonsecConfig(config: unknown): FubonsecConfig {
  return fubonsecConfigSchema.parse(config);
}

export function createFubonsecConnector(
  client?: FubonsecClient,
): Connector<FubonsecConfig, Omit<InvestmentPosition, "id" | "connectorId">> {
  return {
    id: "fubonsec",
    name: "富邦證券",
    async sync(config) {
      const live = client
        ? {
            holdings: await client.fetchHoldings(),
            trades: await client.fetchTrades(),
            settlementBalances: await client.fetchSettlementBalances(),
            settlementMovements: await client.fetchSettlementMovements(),
          }
        : undefined;

      if (!live && !hasInlineRecords(config)) {
        throw new FubonsecConnectorNotImplementedError();
      }

      const holdings = [...config.holdings, ...(live?.holdings ?? [])];
      const trades = [...config.trades, ...(live?.trades ?? [])];
      const settlementBalances = [
        ...config.settlementBalances,
        ...(live?.settlementBalances ?? []),
      ];
      const settlementMovements = [
        ...config.settlementMovements,
        ...(live?.settlementMovements ?? []),
      ];
      const bankAccounts = dedupeBySourceId([
        ...settlementBalances.map(toSettlementBankAccount),
        ...settlementMovements.map(toMovementBankAccount),
      ]);
      const positions = dedupeBySourceId(holdings.map(toInvestmentPosition));
      const bankBalanceSnapshots = dedupeByAccountAndSourceId(
        settlementBalances.map(toBankBalanceSnapshot),
      );
      const bankTransactions = dedupeByAccountAndSourceId(
        settlementMovements.map(toBankTransaction),
      );
      const investmentTransactions = dedupeByAccountAndSourceId(
        trades.map(toInvestmentTransaction),
      );
      const totalInvestmentValue = positions.reduce(
        (sum, position) => sum + (position.marketValue ?? 0),
        0,
      );
      const totalSettlementCash = bankBalanceSnapshots.reduce(
        (sum, snapshot) => sum + snapshot.balance,
        0,
      );
      const latestDate = latestValueDate(positions, bankBalanceSnapshots);

      return {
        records: positions,
        bankAccounts,
        bankBalanceSnapshots,
        bankTransactions,
        investmentTransactions,
        netWorthHistory:
          latestDate && (totalInvestmentValue || totalSettlementCash)
            ? [
                {
                  date: latestDate,
                  netWorth: totalInvestmentValue + totalSettlementCash,
                  assetType: "stock",
                } satisfies NetWorthHistoryPoint,
              ]
            : [],
      };
    },
  };
}

export const fubonsecConnector = createFubonsecConnector();

function hasInlineRecords(config: FubonsecConfig) {
  return (
    config.holdings.length > 0 ||
    config.trades.length > 0 ||
    config.settlementBalances.length > 0 ||
    config.settlementMovements.length > 0
  );
}

function toInvestmentPosition(
  holding: FubonsecHolding,
): Omit<InvestmentPosition, "id" | "connectorId"> {
  const accountId = brokerAccountId(holding);
  const symbol = normalizedText(holding.symbol);
  const name = normalizedText(holding.name) ?? symbol ?? "未命名證券";
  const assetType = toPositionAssetType(holding.assetType);
  return {
    sourceId: [accountId, "position", symbol ?? name].join(":"),
    assetType,
    symbol,
    name,
    quantity: parseDecimal(holding.quantity),
    marketValue: parseInteger(holding.marketValue),
    currency: holding.currency || "TWD",
    asOfDate: normalizeDate(holding.asOfDate),
    raw: holding.raw ?? holding,
  };
}

function toInvestmentTransaction(
  trade: FubonsecTrade,
): Omit<InvestmentTransaction, "id" | "connectorId"> {
  const accountId = brokerAccountId(trade);
  const sourceId =
    normalizedText(trade.sourceId) ??
    [
      normalizeDate(trade.tradeDate ?? trade.postedDate ?? ""),
      normalizedText(trade.transactionCode) ??
        normalizedText(trade.transactionName) ??
        "trade",
      normalizedText(trade.symbol) ?? normalizedText(trade.name) ?? "unknown",
      parseDecimal(trade.quantity)?.toString() ?? "",
      parseDecimal(trade.price)?.toString() ?? "",
      parseInteger(trade.amount)?.toString() ?? "",
    ].join(":");
  return {
    accountId,
    sourceId,
    brokerNo: normalizedText(trade.brokerNo),
    brokerAccount: normalizedText(trade.brokerAccount),
    brokerName: normalizedText(trade.brokerName) ?? "富邦證券",
    symbol: normalizedText(trade.symbol),
    name: normalizedText(trade.name),
    assetType: trade.assetType,
    tradeDate: trade.tradeDate ? normalizeDate(trade.tradeDate) : undefined,
    postedDate: trade.postedDate ? normalizeDate(trade.postedDate) : undefined,
    transactionCode: normalizedText(trade.transactionCode),
    transactionName: normalizedText(trade.transactionName),
    quantity: parseDecimal(trade.quantity),
    price: parseDecimal(trade.price),
    amount: parseInteger(trade.amount),
    currency: trade.currency || "TWD",
    raw: trade.raw ?? trade,
  };
}

function toSettlementBankAccount(
  balance: FubonsecSettlementBalance,
): Omit<BankAccount, "id" | "connectorId"> {
  return settlementBankAccount(balance);
}

function toMovementBankAccount(
  movement: FubonsecSettlementMovement,
): Omit<BankAccount, "id" | "connectorId"> {
  return settlementBankAccount(movement);
}

function settlementBankAccount(
  record: Pick<
    FubonsecSettlementBalance | FubonsecSettlementMovement,
    | "accountId"
    | "brokerNo"
    | "brokerAccount"
    | "brokerName"
    | "bankCode"
    | "bankAccount"
    | "currency"
    | "raw"
  >,
): Omit<BankAccount, "id" | "connectorId"> {
  const accountId = settlementAccountId(record);
  return {
    sourceId: accountId,
    institutionName: record.brokerName ?? "富邦證券",
    accountName: "富邦證券交割帳戶",
    accountType: "settlement_cash",
    currency: record.currency || "TWD",
    raw: record.raw ?? record,
  };
}

function toBankBalanceSnapshot(
  balance: FubonsecSettlementBalance,
): Omit<BankBalanceSnapshot, "id" | "connectorId"> {
  const accountId = settlementAccountId(balance);
  const asOfAt = normalizeDateTime(balance.asOfAt);
  return {
    accountId,
    sourceId: `${accountId}:${asOfAt}`,
    balance: parseInteger(balance.balance) ?? 0,
    availableBalance: parseInteger(balance.availableBalance),
    currency: balance.currency || "TWD",
    asOfAt,
    raw: balance.raw ?? balance,
  };
}

function toBankTransaction(
  movement: FubonsecSettlementMovement,
): Omit<BankTransaction, "id" | "connectorId"> {
  const accountId = settlementAccountId(movement);
  const effectiveDate = normalizeDate(
    movement.postedDate ?? movement.authorizedAt ?? "",
  );
  return {
    accountId,
    sourceId:
      normalizedText(movement.sourceId) ??
      [
        accountId,
        effectiveDate,
        parseInteger(movement.amount)?.toString() ?? "0",
        normalizedText(movement.description) ?? "settlement",
      ].join(":"),
    postedDate: movement.postedDate
      ? normalizeDate(movement.postedDate)
      : undefined,
    authorizedAt: movement.authorizedAt
      ? normalizeDateTime(movement.authorizedAt)
      : undefined,
    amount: parseInteger(movement.amount) ?? 0,
    currency: movement.currency || "TWD",
    description: normalizedText(movement.description),
    counterparty: normalizedText(movement.counterparty),
    status: "posted",
    raw: movement.raw ?? movement,
  };
}

function brokerAccountId(
  record: Pick<FubonsecHolding | FubonsecTrade, "accountId"> & {
    brokerNo?: string;
    brokerAccount?: string;
  },
) {
  const explicit = normalizedText(record.accountId);
  if (explicit) return explicit;
  const derived = [
    normalizedText(record.brokerNo),
    normalizedText(record.brokerAccount),
  ]
    .filter(Boolean)
    .join("-");
  return derived || "fubonsec";
}

function settlementAccountId(
  record: Pick<
    FubonsecSettlementBalance | FubonsecSettlementMovement,
    "accountId" | "brokerNo" | "brokerAccount" | "bankCode" | "bankAccount"
  >,
) {
  const explicit = normalizedText(record.accountId);
  if (explicit) return explicit;
  const broker = [record.brokerNo, record.brokerAccount]
    .map(normalizedText)
    .filter(Boolean)
    .join("-");
  const bank = [record.bankCode, record.bankAccount]
    .map(normalizedText)
    .filter(Boolean)
    .join("-");
  return ["settlement", broker || "fubonsec", bank].filter(Boolean).join(":");
}

function toPositionAssetType(
  value: FubonsecHolding["assetType"],
): InvestmentPosition["assetType"] {
  return value === "etf" || value === "fund" ? value : "stock";
}

function parseInteger(value: string | number | undefined) {
  const parsed = parseDecimal(value);
  return parsed === undefined ? undefined : Math.round(parsed);
}

function parseDecimal(value: string | number | undefined) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  const normalized = value
    .replace(/,/g, "")
    .replace(/[＋﹢]/g, "+")
    .replace(/[－−]/g, "-")
    .trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeDate(value: string) {
  const trimmed = value.trim();
  const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const slashed = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (slashed)
    return `${slashed[1]}-${slashed[2].padStart(2, "0")}-${slashed[3].padStart(2, "0")}`;
  return trimmed.slice(0, 10);
}

function normalizeDateTime(value: string) {
  const trimmed = value.trim();
  if (/^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}T${trimmed.slice(8, 10)}:${trimmed.slice(10, 12)}:${trimmed.slice(12, 14)}+08:00`;
  }
  return trimmed.includes("T") ? trimmed : normalizeDate(trimmed);
}

function normalizedText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function latestValueDate(
  positions: Array<Omit<InvestmentPosition, "id" | "connectorId">>,
  snapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>,
) {
  const dates = [
    ...positions.map((position) => position.asOfDate),
    ...snapshots.map((snapshot) => snapshot.asOfAt.slice(0, 10)),
  ].filter(Boolean);
  return dates.sort().at(-1);
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]) {
  return Array.from(
    records
      .reduce(
        (map, record) => map.set(record.sourceId, record),
        new Map<string, T>(),
      )
      .values(),
  );
}

function dedupeByAccountAndSourceId<
  T extends { accountId: string; sourceId: string },
>(records: T[]) {
  return Array.from(
    records
      .reduce(
        (map, record) =>
          map.set(`${record.accountId}:${record.sourceId}`, record),
        new Map<string, T>(),
      )
      .values(),
  );
}
