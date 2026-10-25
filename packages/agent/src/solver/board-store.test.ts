import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { solverBoardRootDir } from "./board-store"

const ORIGINAL_BOARD_DIR = process.env.CAIRN_OBSERVER_BOARD_DIR
const ORIGINAL_SESSION_DIR = process.env.TCH_SOLVER_SESSION_DIR

afterEach(() => {
    if (ORIGINAL_BOARD_DIR === undefined) delete process.env.CAIRN_OBSERVER_BOARD_DIR
    else process.env.CAIRN_OBSERVER_BOARD_DIR = ORIGINAL_BOARD_DIR
    if (ORIGINAL_SESSION_DIR === undefined) delete process.env.TCH_SOLVER_SESSION_DIR
    else process.env.TCH_SOLVER_SESSION_DIR = ORIGINAL_SESSION_DIR
})

describe("solver board root", () => {
    test("explicit session directory keeps the upstream layout", () => {
        process.env.CAIRN_OBSERVER_BOARD_DIR = "/project/.cairn/board"
        expect(solverBoardRootDir("/task/session")).toBe(join("/task/session", ".observer"))
    })

    test("Cairn board directory is used verbatim", () => {
        process.env.CAIRN_OBSERVER_BOARD_DIR = "/project/.cairn/board"
        process.env.TCH_SOLVER_SESSION_DIR = "/task/session"
        expect(solverBoardRootDir()).toBe("/project/.cairn/board")
    })

    test("falls back to the per-session board in challenge mode", () => {
        delete process.env.CAIRN_OBSERVER_BOARD_DIR
        process.env.TCH_SOLVER_SESSION_DIR = "/task/session"
        expect(solverBoardRootDir()).toBe(join("/task/session", ".observer"))
    })

    test("fails closed when no location is configured", () => {
        delete process.env.CAIRN_OBSERVER_BOARD_DIR
        delete process.env.TCH_SOLVER_SESSION_DIR
        expect(() => solverBoardRootDir()).toThrow("CAIRN_OBSERVER_BOARD_DIR or TCH_SOLVER_SESSION_DIR")
    })
})
