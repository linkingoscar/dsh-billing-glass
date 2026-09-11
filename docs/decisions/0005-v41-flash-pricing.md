# V4.1 Flash pricing boundary

Date: 2026-09-11

The official [release announcement](https://api-docs.deepseek.com/news/news260910)
places the new Flash prices at September 10, 2026 04:00 UTC (12:00 Beijing time).
Append a policy at that instant rather than replacing the August policy. The two
legacy Flash names now resolve to `deepseek-flash`, including vision-exp.

Prices per million tokens, input / cache-read / output:

| Model / band | CNY | USD |
| --- | --- | --- |
| Flash peak | 2 / 0.04 / 8 | 0.3 / 0.006 / 1.2 |
| Flash off-peak | 1 / 0.02 / 4 | 0.15 / 0.003 / 0.6 |
| Pro peak | 9 / 0.3 / 27 | 1.32 / 0.044 / 3.96 |
| Pro off-peak | 4.5 / 0.15 / 13.5 | 0.66 / 0.022 / 1.98 |

The current [CNY pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
and [USD pricing page](https://api-docs.deepseek.com/quick_start/pricing/), checked
September 11, say Pro continues after September 14 with unchanged billing. That
supersedes the announcement's earlier retirement notice; do not schedule a Pro alias.
Peak windows remain Beijing weekdays 09:00–12:00 and 14:00–18:00.

Existing ledger snapshots, including entries previously marked unpriced, are preserved.
This update does not migrate or rewrite recorded spending. Newly ingested events use
their message timestamp. Dedicated DeepSeek prices take precedence over the generic
pi-ai catalog. Boundary, currency, alias, weekend and retained-snapshot behavior are
covered by the pricing and session replay tests.
