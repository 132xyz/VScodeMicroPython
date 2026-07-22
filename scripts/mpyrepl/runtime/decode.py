"""UTF-8 streaming decode helpers.

:return: None
"""

from __future__ import annotations

import codecs


class Utf8StreamDecoder:
    """Incrementally decode UTF-8 bytes without crashing on split code points.

    :return: None
    """

    def __init__(self) -> None:
        """Create a UTF-8 incremental decoder.

        :return: None
        """
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def feed(self, chunk: bytes) -> str:
        """Decode one chunk of bytes.

        :param chunk: Incoming byte chunk.
        :return: Decoded text.
        """
        return self._decoder.decode(chunk)

    def flush(self) -> str:
        """Flush buffered partial code points.

        :return: Decoded trailing text.
        """
        return self._decoder.decode(b"", final=True)
