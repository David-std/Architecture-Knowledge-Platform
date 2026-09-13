"""Compatibility import surface for optional document-intelligence providers.

Provider implementations live in dedicated modules so each real provider
contract can evolve independently without hiding flattening shortcuts here.
"""

from .chunkr_runtime import ChunkrAdapter
from .docling_native import DoclingAdapter
from .marker_native import MarkerAdapter

__all__ = ["ChunkrAdapter", "DoclingAdapter", "MarkerAdapter"]
