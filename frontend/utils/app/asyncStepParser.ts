// Pure parsing helpers for the async chat stream: NAT intermediate-step lines
// and OpenAI-compatible content deltas. No I/O — safe to unit test directly.

function stringifyContent(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function extractAsyncStreamContentDelta(
  parsed: any,
  accumulatedText: string,
): string {
  const deltaContent = parsed?.choices?.[0]?.delta?.content;
  if (deltaContent !== null && deltaContent !== undefined) {
    return stringifyContent(deltaContent);
  }

  let content =
    parsed?.choices?.[0]?.message?.content ??
    parsed?.output ??
    parsed?.answer ??
    parsed?.value ??
    parsed?.text ??
    parsed?.content ??
    parsed?.data?.output ??
    parsed?.data?.content ??
    '';

  if (!content && Array.isArray(parsed?.outputs)) {
    content = parsed.outputs.join('\n');
  }

  const text = stringifyContent(content);
  if (!text) return '';

  // Some providers send a full-so-far snapshot instead of a token delta.
  // The UI and job status already accumulate chunks, so only forward the new
  // suffix when the snapshot repeats what we have already seen.
  if (accumulatedText && text.startsWith(accumulatedText)) {
    return text.slice(accumulatedText.length);
  }

  return text;
}

/**
 * Parse a NAT v1.6.0+ `intermediate_data:` JSON line into the
 * IntermediateStep shape the frontend expects.
 */
export function parseIntermediateDataLine(json: string): any | null {
  try {
    const parsed = JSON.parse(json);
    const isComplete = parsed.name?.includes('Complete:');
    const isWorkflow = parsed.name?.includes('<workflow>');

    const cleanName =
      parsed.name
        ?.replace(/^Function (Start|Complete): /, '')
        .replace(/<|>/g, '') || 'System Step';

    let eventType: string;
    if (isWorkflow) {
      eventType = isComplete ? 'WORKFLOW_END' : 'WORKFLOW_START';
    } else {
      eventType = isComplete ? 'TOOL_END' : 'TOOL_START';
    }

    return {
      parent_id: parsed.parent_id || 'root',
      function_ancestry: {
        node_id: parsed.id || `step-${Date.now()}`,
        parent_id: parsed.parent_id || null,
        function_name: cleanName,
        depth: 0,
      },
      payload: {
        event_type: eventType,
        event_timestamp: Date.now() / 1000,
        name: cleanName,
        metadata: { original_payload: parsed },
        data: { output: parsed.payload || '' },
        UUID: parsed.id || `${Date.now()}-${Math.random()}`,
      },
    };
  } catch {
    return null;
  }
}
