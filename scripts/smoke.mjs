/**
 * Pi-Staffs 冒烟入口（薄壳）：仍是一条命令 —— node scripts/smoke.mjs，零依赖。
 * 具体段落在 scripts/smoke/*.mjs，按原单体文件顺序执行；_shared.mjs 持有
 * 环境隔离/sandbox/断言台账与宿主桩。全部段落跑完才 rmSync 清场（清理时机与所有权不变）。
 */
import { checks, sandbox, rmSync } from "./smoke/_shared.mjs";
import { run as runHostCore } from "./smoke/core.mjs";
import { run as runMisc } from "./smoke/misc.mjs";
import { runPoolMatcher, runPoolFacade } from "./smoke/pool.mjs";
import { runRoute, runJevPanel, runRouteTail } from "./smoke/route.mjs";
import { run as runAa } from "./smoke/aa.mjs";

await runHostCore();
await runMisc();
await runPoolMatcher();
await runRoute();
await runJevPanel();
await runAa();
await runPoolFacade();
await runRouteTail();

// 全部段落跑完才清场（票 03 段共用同一 sandbox）。
rmSync(sandbox, { recursive: true, force: true });
console.log(`smoke ok（${checks.length} 项）：`);
for (const name of checks) console.log(`  - ${name}`);
