// The "Open" file picker: one hidden <input type=file> kept in the document (iOS Safari only
// opens pickers for inputs that are attached).
import { openFile } from "./actions";

let input: HTMLInputElement | null = null;

export function openFilePicker() {
  if (!input) {
    input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.addEventListener("change", () => {
      const file = input?.files?.[0];
      if (input) input.value = ""; // picking the same file again still fires "change"
      if (file) void openFile(file);
    });
    document.body.append(input);
  }
  input.click();
}
