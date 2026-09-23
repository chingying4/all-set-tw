// Run with: npx tsx packages/connectors/tests/selfcheck/fubonsec.selfcheck.ts
import assert from "node:assert/strict";
import {
  createFubonsecConnector,
  FubonsecConnectorNotImplementedError,
  parseFubonsecConfig,
} from "../../src/fubonsec";

const config = parseFubonsecConfig({
  userId: "A123456789",
  account: "fubon-user",
  password: "secret",
  holdings: [
    {
      brokerNo: "9600",
      brokerAccount: "1234567",
      brokerName: "富邦證券",
      symbol: "2330",
      name: "台積電",
      assetType: "stock",
      quantity: "1,000",
      marketValue: "950,000",
      asOfDate: "20260923",
    },
    {
      brokerNo: "9600",
      brokerAccount: "1234567",
      symbol: "0050",
      name: "元大台灣50",
      assetType: "etf",
      quantity: 200,
      marketValue: 36000,
      asOfDate: "2026/09/23",
    },
  ],
  trades: [
    {
      brokerNo: "9600",
      brokerAccount: "1234567",
      sourceId: "statement-20260920-2330-buy",
      symbol: "2330",
      name: "台積電",
      assetType: "stock",
      tradeDate: "2026/09/20",
      postedDate: "2026/09/22",
      transactionCode: "B",
      transactionName: "買進",
      quantity: "1,000",
      price: "950",
      amount: "-950000",
    },
  ],
  settlementBalances: [
    {
      brokerNo: "9600",
      brokerAccount: "1234567",
      bankCode: "012",
      bankAccount: "1234567890",
      balance: "12,345",
      availableBalance: "10,000",
      asOfAt: "20260923153000",
    },
  ],
  settlementMovements: [
    {
      brokerNo: "9600",
      brokerAccount: "1234567",
      bankCode: "012",
      bankAccount: "1234567890",
      sourceId: "settlement-20260922-2330",
      postedDate: "20260922",
      amount: "-950000",
      description: "買進台積電交割款",
    },
  ],
});

const result = await createFubonsecConnector().sync(config);

assert.equal(result.records.length, 2);
assert.deepEqual(result.records[0], {
  sourceId: "9600-1234567:position:2330",
  assetType: "stock",
  symbol: "2330",
  name: "台積電",
  quantity: 1000,
  marketValue: 950000,
  currency: "TWD",
  asOfDate: "2026-09-23",
  raw: config.holdings[0],
});
assert.equal(result.records[1].assetType, "etf");
assert.equal(result.investmentTransactions?.length, 1);
assert.equal(
  result.investmentTransactions?.[0]?.sourceId,
  "statement-20260920-2330-buy",
);
assert.equal(result.investmentTransactions?.[0]?.amount, -950000);
assert.equal(result.bankAccounts?.[0]?.accountType, "settlement_cash");
assert.equal(
  result.bankAccounts?.[0]?.sourceId,
  "settlement:9600-1234567:012-1234567890",
);
assert.equal(result.bankBalanceSnapshots?.[0]?.balance, 12345);
assert.equal(
  result.bankBalanceSnapshots?.[0]?.asOfAt,
  "2026-09-23T15:30:00+08:00",
);
assert.equal(result.bankTransactions?.[0]?.amount, -950000);
assert.equal(result.netWorthHistory?.[0]?.netWorth, 998345);

await assert.rejects(
  () =>
    createFubonsecConnector().sync(
      parseFubonsecConfig({
        userId: "A123456789",
        account: "fubon-user",
        password: "secret",
      }),
    ),
  FubonsecConnectorNotImplementedError,
);
