from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class JapaneseSplitMode(str, Enum):
    C = "C"
    B = "B"
    A = "A"


@dataclass(frozen=True)
class JapaneseMorpheme:
    surface: str
    start: int
    end: int
    part_of_speech: tuple[str, ...]


def tokenize_japanese(
    text: str,
    mode: JapaneseSplitMode = JapaneseSplitMode.C,
) -> list[JapaneseMorpheme]:
    try:
        from sudachipy import Dictionary, SplitMode
    except ImportError as error:
        raise RuntimeError(
            "精准 SRT 日文分段需要 SudachiPy 和 SudachiDict-core。"
        ) from error

    sudachi_mode = {
        JapaneseSplitMode.C: SplitMode.C,
        JapaneseSplitMode.B: SplitMode.B,
        JapaneseSplitMode.A: SplitMode.A,
    }[mode]
    tokenizer = Dictionary().create()
    return [
        JapaneseMorpheme(
            surface=morpheme.surface(),
            start=morpheme.begin(),
            end=morpheme.end(),
            part_of_speech=tuple(morpheme.part_of_speech()),
        )
        for morpheme in tokenizer.tokenize(text, sudachi_mode)
        if morpheme.surface()
    ]


def japanese_alignment_surfaces(text: str) -> list[str]:
    return [
        morpheme.surface
        for morpheme in tokenize_japanese(text, JapaneseSplitMode.A)
    ]


def japanese_boundary_morphemes(text: str) -> list[JapaneseMorpheme]:
    morphemes: list[JapaneseMorpheme] = []
    for c_morpheme in tokenize_japanese(text, JapaneseSplitMode.C):
        b_morphemes = tokenize_japanese(
            c_morpheme.surface, JapaneseSplitMode.B
        )
        split_morphemes = b_morphemes
        if len(b_morphemes) == 1:
            split_morphemes = tokenize_japanese(
                c_morpheme.surface, JapaneseSplitMode.A
            )
        if len(split_morphemes) == 1:
            morphemes.append(c_morpheme)
            continue
        offset = c_morpheme.start
        morphemes.extend(
            JapaneseMorpheme(
                surface=morpheme.surface,
                start=offset + morpheme.start,
                end=offset + morpheme.end,
                part_of_speech=morpheme.part_of_speech,
            )
            for morpheme in split_morphemes
        )
    return morphemes
