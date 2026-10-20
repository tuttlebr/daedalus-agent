"""Exact ingestion preflights that can overlap a separately owned Milvus write."""

import copy


class ProbeScripts:
    def __init__(self, scripts):
        self.scripts = copy.deepcopy(scripts)
        for script in self.scripts:
            methods = [call["method"] for call in script]
            if methods not in [
                ["ShowCollections"],
                ["ShowCollections", "DescribeCollection"],
            ]:
                raise ValueError(
                    "Preflight must only list collections and describe its target"
                )
        self.index = 0
        self.pending = {}

    def claim(self, method, identifier):
        if method == "ShowCollections":
            if identifier in self.pending or self.index >= len(self.scripts):
                return {"method": "<unexpected probe>"}
            self.pending[identifier] = list(self.scripts[self.index])
            self.index += 1
        pending = self.pending.get(identifier)
        if not pending:
            return None
        expected = pending.pop(0)
        if not pending:
            del self.pending[identifier]
        return expected

    @property
    def remaining(self):
        return sum(len(script) for script in self.scripts[self.index :]) + sum(
            len(script) for script in self.pending.values()
        )
