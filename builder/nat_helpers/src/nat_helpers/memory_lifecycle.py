"""Shared memory deletion lifecycle for authenticated APIs and approved tools."""

from nat_helpers.hindsight_memory_context import clear_user_memory_caches


async def clear_user_memory(client, user_id: str, *, clear_caches=None):
    """Delete durable memory, derived knowledge, and this user's cached context.

    Failures propagate: callers must not acknowledge complete deletion while a
    derived store still contains memories. Other users' banks are never touched.
    """
    tree = await client.knowledge_tree(user_id=user_id)
    result = await client.clear_memories(user_id=user_id)
    for root in tree:
        if isinstance(root, dict) and str(root.get("id") or "").strip():
            await client.delete_knowledge_node(user_id=user_id, node_id=str(root["id"]))
    await (clear_caches or clear_user_memory_caches)(user_id)
    return result
