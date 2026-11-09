import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field, FieldGroup } from "./Field";

describe("Field", () => {
  it("associates the label, hint and control", () => {
    render(
      <Field
        id="frame-width"
        label="Frame width"
        defaultValue="640"
        hint="Blank keeps source width."
        suffix="px"
        mono
      />,
    );

    const input = screen.getByLabelText("Frame width") as HTMLInputElement;
    expect(input.id).toBe("frame-width");
    expect(input.getAttribute("aria-describedby")).toBe("frame-width-hint");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect((input as unknown as { value: string }).value).toBe("640");

    const hint = document.getElementById("frame-width-hint") as HTMLElement;
    expect(hint.className).toContain("field__hint");
    expect(hint.textContent).toBe("Blank keeps source width.");
    expect(screen.getByText("px")).toBeTruthy();
  });

  it("announces an invalid value and replaces the hint", () => {
    render(
      <Field
        id="process-fps"
        label="Process fps"
        error="Must be between 0.1 and 240."
        hint="Blank follows the source frame rate."
      />,
    );

    const input = screen.getByLabelText("Process fps") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("process-fps-error");
    expect(screen.getByRole("alert").textContent).toBe("Must be between 0.1 and 240.");
    expect(screen.queryByText(/Blank follows/)).toBeNull();
  });

  it("disables the control and reports busy while loading", () => {
    render(<Field id="min-samples" label="Min samples" loading />);

    const input = screen.getByLabelText("Min samples") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-busy")).toBe("true");
  });

  it("keeps the required marker out of the accessible label", () => {
    render(<Field id="warmup" label="Warm-up tracks" required />);

    const input = screen.getByLabelText("Warm-up tracks") as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(screen.getByText("Warm-up tracks").getAttribute("data-required")).toBe("true");
  });
});

describe("FieldGroup", () => {
  it("groups fields under a legend with an optional description", () => {
    const { container } = render(
      <FieldGroup legend="Processing" description="Applied to every frame." columns={3}>
        <Field id="a" label="A" />
        <Field id="b" label="B" />
        <Field id="c" label="C" />
      </FieldGroup>,
    );

    const group = screen.getByRole("group", { name: "Processing" });
    expect(group.getAttribute("aria-describedby")).toBe("processing-description");
    expect(screen.getByText("Applied to every frame.").textContent).toBe("Applied to every frame.");
    expect(container.querySelector(".field-group")?.getAttribute("data-columns")).toBe("3");
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
  });

  it("disables the whole group when the document is not writable", () => {
    render(
      <FieldGroup legend="Tracking" disabled>
        <Field id="max-age" label="Max age" />
      </FieldGroup>,
    );

    // A disabled fieldset disables its controls natively; the input's own
    // disabled attribute stays unset, so assert on the group itself.
    const group = screen.getByRole("group", { name: "Tracking" }) as HTMLFieldSetElement;
    expect(group.disabled).toBe(true);
    expect(screen.getByLabelText("Max age")).toBeTruthy();
  });
});
