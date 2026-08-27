function extractText(message) {
    if (!message ||
        typeof message !== "object") {
        return undefined;
    }
    const m = message;
    const content = m.content;
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return undefined;
    }
    const parts = [];
    for (const item of content) {
        if (item &&
            typeof item === "object") {
            const block = item;
            if (block.type === "text" &&
                typeof block.text === "string") {
                parts.push(block.text);
            }
        }
    }
    const result = parts.join("");
    return result || undefined;
}
export function updateRpcState(state, event) {
    switch (event.type) {
        case "agent_start":
            state.agentStarted = true;
            break;
        case "agent_end":
            state.agentEnded = true;
            if (Array.isArray(event.messages)) {
                for (const message of event.messages) {
                    const text = extractText(message);
                    if (text) {
                        state.finalMessage = text;
                    }
                }
            }
            break;
        case "agent_settled":
            state.settled = true;
            break;
        case "message_end": {
            const text = extractText(event.message);
            if (text) {
                state.finalMessage = text;
            }
            break;
        }
        case "message_start": {
            const text = extractText(event.message);
            if (text) {
                state.finalMessage = text;
            }
            break;
        }
        case "message_update": {
            const assistantEvent = event.assistantMessageEvent;
            if (assistantEvent &&
                typeof assistantEvent === "object") {
                const e = assistantEvent;
                if (e.type === "text_delta" &&
                    typeof e.delta === "string") {
                    state.finalMessage =
                        (state.finalMessage ?? "") +
                            e.delta;
                }
            }
            break;
        }
    }
}
export function buildResult(task, worker, execution, state, scope, tests, error) {
    let status;
    if (error?.code === "TASK_TIMEOUT") {
        status = "timeout";
    }
    else if (error?.code === "TASK_CANCELLED") {
        status = "cancelled";
    }
    else if (error) {
        status = "failed";
    }
    else {
        status = "success";
    }
    return {
        schema_version: "1.0",
        task_id: task.task_id,
        status,
        worker,
        execution,
        result: {
            summary: state.finalMessage
                ? state.finalMessage.slice(0, 4000)
                : undefined,
            final_message: state.finalMessage,
            changed_files: scope.changed_files
        },
        scope,
        tests,
        error,
        metadata: task.metadata
    };
}
//# sourceMappingURL=result.js.map