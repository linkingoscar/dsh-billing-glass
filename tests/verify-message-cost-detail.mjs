import { test } from "node:test";
import assert from "node:assert/strict";
import { messageCostPresentation } from "../src/client/message-cost-detail.js";
const sample = { costNative: 0.15, nativeCurrency: "USD", model: "example-model", inputTokens: 1_000_000, priced: true,
  pricingSnapshot: {source:"pi-ai@historical-version",mode:"offPeak",usd:{input:.15,cacheRead:.003,output:.6}} };

test("message estimates expose their frozen price source and rates rather than a current catalog", () => {
  const view = messageCostPresentation(sample);
  assert.match(view.label, /^≈/);
  assert.match(view.detail, /本地估算.*非官方账单/);
  assert.match(view.detail, /pi-ai@historical-version/);
  assert.match(view.detail, /谷价/);
  assert.match(view.detail, /输入 0.15 \/ 缓存 0.003 \/ 输出 0.6/);
});
test("unpriced never renders an apparent zero charge or an invented source", () => {
  const view = messageCostPresentation({...sample,priced:false,costNative:0,pricingSnapshot:null});
  assert.equal(view.label,"未计价");
  assert.match(view.detail,/费用未计入/);
  assert.doesNotMatch(view.detail,/pi-ai|\$0/);
});
test("older hosts/records remain usable without claiming current pricing as historical provenance", () => {
  const view=messageCostPresentation({cost:0,currency:"CNY",priced:true});
  assert.match(view.label,/^≈/);
  assert.match(view.detail,/历史价格来源未记录/);
  assert.doesNotMatch(view.detail,/每百万/);
});
