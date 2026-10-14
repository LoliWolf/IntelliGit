import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { Workbench } from "../../e2e/pageObjects/workbench";

function picker() {
    let visible = false;
    const input = {
        waitFor: vi.fn(async (_options: { state: string; timeout: number }) => undefined),
        fill: vi.fn(async (_text: string, _options: { timeout: number }) => undefined),
        isVisible: vi.fn(async () => visible),
    };
    const click = vi.fn(async (_options: { timeout: number }) => {
        visible = false;
    });
    const option = {
        filter: vi.fn(() => ({ first: () => ({ click }) })),
    };
    const page = {
        locator: vi.fn(() => ({ first: () => input })),
        getByRole: vi.fn(() => option),
        keyboard: {
            press: vi.fn(async () => {
                visible = true;
            }),
        },
    };
    return {
        workbench: new Workbench(page as unknown as Page),
        page,
        input,
        click,
        close: () => {
            visible = false;
        },
    };
}

describe("read-only workbench file navigation", () => {
    it("selects the requested file and waits for the picker to close", async () => {
        const { workbench, page, input, click } = picker();
        await workbench.openFile("package-smoke.ts");
        expect(page.keyboard.press).toHaveBeenCalledTimes(1);
        expect(input.fill).toHaveBeenCalledWith("package-smoke.ts", { timeout: 3_000 });
        expect(click).toHaveBeenCalledTimes(1);
        expect(input.waitFor).toHaveBeenLastCalledWith({ state: "hidden", timeout: 3_000 });
    });

    it.each(["input", "option"] as const)(
        "reopens a picker dismissed during %s interaction",
        async (step) => {
            const { workbench, page, input, click, close } = picker();
            const reject = async () => {
                close();
                throw new Error("picker dismissed");
            };
            if (step === "input") input.fill.mockImplementationOnce(reject);
            else click.mockImplementationOnce(reject);
            await workbench.openFile("package-smoke.ts");
            expect(page.keyboard.press).toHaveBeenCalledTimes(2);
        },
    );

    it("does not retry a visible picker that cannot select the file", async () => {
        const { workbench, page, click } = picker();
        click.mockRejectedValueOnce(new Error("file not offered"));
        await expect(workbench.openFile("missing.ts")).rejects.toThrow("file not offered");
        expect(page.keyboard.press).toHaveBeenCalledTimes(1);
    });

    it("bounds reopening at five attempts without changing test-level retries", async () => {
        const { workbench, page, input, close } = picker();
        input.fill.mockImplementation(async () => {
            close();
            throw new Error("picker stays dismissed");
        });
        await expect(workbench.openFile("package-smoke.ts")).rejects.toThrow(
            "picker stays dismissed",
        );
        expect(page.keyboard.press).toHaveBeenCalledTimes(5);
    });

    it("does not replay a completed selection when the picker fails to close", async () => {
        const { workbench, page, input } = picker();
        input.waitFor.mockImplementation(async ({ state }) => {
            if (state === "hidden") throw new Error("picker did not close");
        });
        await expect(workbench.openFile("package-smoke.ts")).rejects.toThrow(
            "picker did not close",
        );
        expect(page.keyboard.press).toHaveBeenCalledTimes(1);
    });
});
