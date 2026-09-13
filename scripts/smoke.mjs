/**
 * 骨架冒烟测试：不启动 Pi，只断言扩展模块的对外契约。
 *
 * 为什么不用真 Pi 跑：扩展在启动时装载，改完要重启会话才能看效果；
 * 这里用桩对象把契约（注册了哪条命令、handler 会不会 notify）钉住，
 * 真装载留给人工 `/reload` + `/pi-staffs`。
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
const mod = await import(pathToFileURL(entry).href);

const registered = [];
mod.default({ registerCommand: (name, opts) => registered.push({ name, opts }) });

const [cmd] = registered;
if (!cmd || cmd.name !== "pi-staffs") throw new Error("未注册 /pi-staffs 命令");
if (typeof cmd.opts?.handler !== "function") throw new Error("命令缺少 handler");

let notified = "";
await cmd.opts.handler("", { ui: { notify: (msg, level) => { notified = msg + " [" + level + "]"; } } });
if (!notified.includes("Pi-Staffs")) throw new Error("handler 未通过 ui.notify 汇报");

console.log("smoke ok:", cmd.name, "->", notified);
