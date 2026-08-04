// Renders the dossier as Markdown.
//
// Markdown rather than plain text on purpose: this is the artifact a PM or
// designer pastes into Notion, Linear, or a GitHub issue, and all three keep
// heading/table structure intact on paste. A .txt would arrive as a wall.
//
// Deliberately English-only even when the UI is localized — a spec sheet gets
// forwarded to people who don't share the operator's locale, and a half-
// translated table of CSS property names helps nobody.

function fmtPx(entry) {
    if (!entry) return "—";
    const rem = entry.rem != null ? ` (${entry.rem}rem)` : "";
    return `${entry.px}px${rem}`;
}

function table(headers, rows) {
    if (!rows.length) return "_None._\n";
    const head = `| ${headers.join(" | ")} |`;
    const sep = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
    return `${head}\n${sep}\n${body}\n`;
}

// Markdown table cells can't contain a raw pipe, and shadow/gradient values
// legitimately do (nested commas are fine, pipes appear in some filter chains).
function cell(value) {
    if (value == null || value === "") return "—";
    return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function sectionPalette(d) {
    const rows = d.aggregates.palette.map((c) => [
        `\`${c.hex}\``,
        cell(c.rgb),
        cell(c.hsl),
        c.roles.join(", "),
        String(c.count),
    ]);
    return table(["Hex", "RGB", "HSL", "Used as", "Count"], rows);
}

function sectionType(d) {
    const rows = d.aggregates.typeStyles.map((t) => {
        const ratio = t.lineHeightRatio ? ` (${t.lineHeightRatio})` : "";
        return [
            cell(t.fontSize) + (t.fontSizeRem ? ` / ${t.fontSizeRem}rem` : ""),
            cell(t.fontWeight),
            cell(t.lineHeight) + ratio,
            cell(t.letterSpacing),
            t.color ? `\`${t.color}\`` : "—",
            t.sample ? `"${cell(t.sample)}"` : "—",
        ];
    });
    return table(
        ["Size", "Weight", "Line height", "Letter spacing", "Colour", "Sample"],
        rows
    );
}

function sectionStates(d) {
    if (d.statesSupported === false) {
        return "_Interaction states could not be sampled on this page._\n";
    }
    if (!d.states || !Object.keys(d.states).length) {
        return "_No style changes on hover, focus, or active._\n";
    }
    let out = "";
    for (const [state, diff] of Object.entries(d.states)) {
        out += `\n**\`:${state}\`**\n\n`;
        const rows = Object.entries(diff).map(([prop, change]) => [
            `\`${prop}\``,
            cell(change.from),
            cell(change.to),
        ]);
        out += table(["Property", "Resting", `On ${state}`], rows);
    }
    return out;
}

function sectionContrast(d) {
    if (!d.contrast || !d.contrast.length) return "_Not evaluated._\n";
    const rows = d.contrast.map((c) => [
        `\`${c.foreground}\``,
        `\`${c.background}\``,
        `${c.ratio}:1`,
        c.largeText ? "Large" : "Normal",
        c.passesAA ? "Pass" : "**Fail**",
        c.passesAAA ? "Pass" : "Fail",
    ]);
    return table(
        ["Foreground", "Background", "Ratio", "Text size", "AA", "AAA"],
        rows
    );
}

function sectionTokens(d) {
    const entries = Object.entries(d.customProperties || {});
    if (!entries.length) {
        return "_No CSS custom properties are in scope on this element._\n";
    }
    const rows = entries.map(([name, info]) => [
        `\`${name}\``,
        info.type,
        info.type === "color" ? `\`${info.hex}\`` : `\`${cell(info.value)}\``,
    ]);
    return table(["Token", "Type", "Value"], rows);
}

function sectionLayout(d) {
    const root = d.nodes && d.nodes[0];
    if (!root) return "_Not available._\n";
    const layout = (root.properties && root.properties.layout) || {};
    const interesting = [
        "display", "flex-direction", "justify-content", "align-items",
        "gap", "row-gap", "column-gap",
        "grid-template-columns", "grid-template-rows", "grid-auto-flow",
        "position", "z-index", "overflow-x", "overflow-y",
    ];
    const rows = interesting
        .filter((p) => layout[p] != null)
        .map((p) => [`\`${p}\``, `\`${cell(layout[p])}\``]);
    return table(["Property", "Value"], rows);
}

function sectionMotion(d) {
    const root = d.nodes && d.nodes[0];
    const motion = (root && root.properties && root.properties.motion) || {};
    const keys = Object.keys(motion);
    if (!keys.length) return "_No transitions or transforms on the root element._\n";
    const rows = keys.map((p) => [`\`${p}\``, `\`${cell(motion[p])}\``]);
    return (
        table(["Property", "Value"], rows) +
        "\n> Values are declarations only — actual motion is not captured.\n"
    );
}

export function buildSpecSheet(d) {
    const el = d.element;
    const s = d.summary || {};
    const title = `${el.role.charAt(0).toUpperCase()}${el.role.slice(1)}`;

    const lines = [];
    const push = (...xs) => lines.push(...xs);

    push(`# ${title} — design spec`, "");
    push(`**Source:** ${d.page.url}`);
    push(`**Element:** \`${el.selector}\``);
    push(`**Captured:** ${d.capturedAt}`);
    if (d.capture) {
        push(
            `**Captured at:** ${d.capture.emulatedWidth}×${d.capture.emulatedHeight} ` +
                `CSS px @ ${d.capture.deviceScaleFactor}×`
        );
    }
    push("");

    push("## At a glance", "");
    push(
        table(
            ["", ""],
            [
                ["Size", `${el.width} × ${el.height} px`],
                ["Background", s.background ? `\`${s.background}\`` : "—"],
                ["Text colour", s.color ? `\`${s.color}\`` : "—"],
                ["Padding", `\`${cell(s.padding)}\``],
                ["Margin", `\`${cell(s.margin)}\``],
                ["Corner radius", `\`${cell(s.borderRadius)}\``],
                ["Border", s.border ? `\`${cell(s.border)}\`` : "—"],
                ["Shadow", s.boxShadow ? `\`${cell(s.boxShadow)}\`` : "—"],
                ["Display", `\`${cell(s.display)}\``],
            ]
        )
    );

    push("## Colour palette", "", sectionPalette(d));
    push("## Typography", "", sectionType(d));

    push("## Spacing scale", "");
    push(
        d.aggregates.spacing.length
            ? d.aggregates.spacing.map((sp) => `\`${fmtPx(sp)}\``).join(" · ") + "\n"
            : "_None._\n"
    );

    if (d.aggregates.gaps.length) {
        push("**Gaps:** " + d.aggregates.gaps.map((g) => `\`${fmtPx(g)}\``).join(" · "), "");
    }

    push("## Corner radii", "");
    push(
        d.aggregates.radii.length
            ? d.aggregates.radii.map((r) => `\`${cell(r.value)}\` (×${r.count})`).join(" · ") + "\n"
            : "_All square._\n"
    );

    push("## Shadows", "");
    push(
        d.aggregates.shadows.length
            ? d.aggregates.shadows.map((sh) => `- \`${cell(sh.value)}\``).join("\n") + "\n"
            : "_None._\n"
    );

    push("## Layout", "", sectionLayout(d));
    push("## Interaction states", "", sectionStates(d));
    push("## Motion", "", sectionMotion(d));
    push("## Accessibility — contrast", "", sectionContrast(d));
    push("## Design tokens", "", sectionTokens(d));

    push("## Font stacks", "");
    push(
        d.aggregates.fontStacks.length
            ? d.aggregates.fontStacks
                  .map((f) => `- \`${cell(f.value)}\` (×${f.count})`)
                  .join("\n") + "\n"
            : "_None._\n"
    );

    // ─── Limits ──────────────────────────────────────────────────────────
    // Stated plainly rather than buried. Computed styles are resolved values:
    // a designer who sees "16px" where the author wrote clamp() and doesn't
    // know that will ship a fixed size and wonder why it doesn't match.
    push("## What this does and doesn't tell you", "");
    push(
        "- Values are **computed**, not authored. `clamp()`, `%`, `vw` and `em` " +
            "are all resolved to pixels by the browser before they can be read, " +
            "so a fluid value appears here as whatever it measured at the capture " +
            "width above.",
        "- Styles inside shadow DOM, `<iframe>`, and `<canvas>` are not readable " +
            "from the page and are listed as gaps below where encountered.",
        "- Webfont files are referenced, not embedded — the font stack is " +
            "recorded but no font binary is included.",
        "- Interaction states are captured by forcing the pseudo-class, so they " +
            "reflect CSS only; states driven by JavaScript class changes are not " +
            "included.",
        ""
    );

    if (d.gaps && d.gaps.length) {
        push("### Gaps encountered", "");
        const seen = new Set();
        for (const g of d.gaps) {
            const key = `${g.type}|${g.tag}`;
            if (seen.has(key)) continue;
            seen.add(key);
            push(`- **${g.type}** (\`<${g.tag}>\`) — ${g.note}`);
        }
        push("");
    }

    if (d.truncated) {
        push(
            `> Traversal stopped at ${d.nodeCount} nodes. The aggregates above ` +
                "cover what was read; deeper nodes were not included.",
            ""
        );
    }

    push("---", "", `Generated by Sharpshooter · ${d.nodeCount} elements analysed`);

    return lines.join("\n");
}
