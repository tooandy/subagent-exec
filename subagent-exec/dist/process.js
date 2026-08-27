import { spawn } from "node:child_process";
export function spawnPi(task) {
    const args = [
        "--mode",
        "rpc",
        "--no-session"
    ];
    if (task.model?.provider) {
        args.push("--provider", task.model.provider);
    }
    if (task.model?.model) {
        args.push("--model", task.model.model);
    }
    const child = spawn("pi", args, {
        cwd: task.cwd ?? process.cwd(),
        stdio: [
            "pipe",
            "pipe",
            "pipe"
        ],
        env: process.env
    });
    if (!child.pid) {
        throw new Error("Failed to obtain Pi process PID");
    }
    return {
        child,
        pid: child.pid
    };
}
//# sourceMappingURL=process.js.map