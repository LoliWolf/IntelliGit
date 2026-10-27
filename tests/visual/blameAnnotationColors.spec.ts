import { expect, test } from "@playwright/test";
import {
    blameAnnotationColors,
    type BlameAgeRange,
} from "../../src/services/blameAnnotationColors";
import { oracles } from "../oracles";

test("blame age shades retain exact endpoints and readable text on customized themes", async ({
    page,
}) => {
    const range: BlameAgeRange = { oldest: 0, newest: 100 };
    const shades = Array.from({ length: 101 }, (_, authorTime) => {
        const shade = blameAnnotationColors(
            {
                commit: "a".repeat(40),
                authorTime,
                line: authorTime,
                author: "Ada",
                authorTimezone: "+0000",
                summary: "Change",
            },
            range,
        );
        if (!shade) throw new Error("Missing committed shade.");
        return shade;
    });
    const backgrounds = [
        "#1f1f1f",
        "#ffffff",
        "#000000",
        "#fefefe",
        "#303446",
        "#2d1050",
        "#62522c",
        "#104c5b",
        "#123912",
        "#83bf54",
        "#898989",
        "#ff0000",
        "#0000ff",
        "#00ff00",
        "#4a4a4a",
        "#858585",
    ];
    const samples = await page.evaluate(
        ({ shades, backgrounds }) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("Canvas color probe unavailable.");
            const rgba = (color: string) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
                return { r, g, b, a: a / 255 };
            };
            const probe = document.createElement("span");
            probe.textContent = "Ada 2020-01-01";
            document.body.append(probe);
            const result = backgrounds.flatMap((background) => {
                document.documentElement.style.setProperty(
                    "--vscode-editor-background",
                    background,
                );
                return shades.map((shade, age) => {
                    for (const [property, value] of [
                        ["background-color", shade.backgroundColor],
                        ["color", shade.color],
                    ]) {
                        if (!CSS.supports(property, value))
                            throw new Error(`Unsupported annotation ${property}: ${value}`);
                        probe.style.setProperty(property, value);
                    }
                    const style = getComputedStyle(probe);
                    return {
                        theme: background,
                        age,
                        foreground: rgba(style.color),
                        background: rgba(style.backgroundColor),
                        expectedBackground: rgba(background),
                    };
                });
            });
            probe.remove();
            return result;
        },
        { shades, backgrounds },
    );
    const unreadable = samples
        .map((sample) => ({
            theme: sample.theme,
            age: sample.age,
            ratio: oracles.get("contrast").contrastRatio(sample.foreground, sample.background),
        }))
        .filter((sample) => sample.ratio < 4.5);
    expect(unreadable).toEqual([]);
    expect(
        samples.filter(
            (sample) =>
                sample.age === 0 &&
                JSON.stringify(sample.background) !== JSON.stringify(sample.expectedBackground),
        ),
    ).toEqual([]);
    expect(
        samples.filter(
            (sample) =>
                sample.age === 100 &&
                (sample.background.r !== 131 ||
                    sample.background.g !== 191 ||
                    sample.background.b !== 84 ||
                    sample.background.a !== 1),
        ),
    ).toEqual([]);
});
