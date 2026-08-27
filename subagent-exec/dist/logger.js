export class Logger {
    task;
    enabled;
    constructor(task, enabled = true) {
        this.task = task;
        this.enabled = enabled;
    }
    log(event, extra = {}) {
        if (!this.enabled) {
            return;
        }
        const payload = {
            ts: new Date().toISOString(),
            task_id: this.task.task_id,
            event,
            ...extra
        };
        process.stderr.write(JSON.stringify(payload) + "\n");
    }
}
//# sourceMappingURL=logger.js.map