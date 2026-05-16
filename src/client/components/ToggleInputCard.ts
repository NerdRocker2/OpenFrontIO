import { LitElement, PropertyValues, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";

const ACTIVE_CARD =
  "bg-malibu-blue/20 border-malibu-blue/50 shadow-[var(--shadow-malibu-blue)]";
const INACTIVE_CARD =
  "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20";
const INPUT_CLASS =
  "w-full text-center rounded bg-black/60 text-white text-sm font-bold border border-white/20 focus:outline-none focus:border-malibu-blue p-1 my-1";
const CARD_LABEL_CLASS =
  "text-xs uppercase font-bold tracking-wider leading-tight break-words hyphens-auto";

function cardClass(active: boolean, extra = ""): string {
  return `w-full h-full rounded-xl border cursor-pointer transition-all duration-200 active:scale-95 ${extra} ${active ? ACTIVE_CARD : INACTIVE_CARD}`;
}

@customElement("toggle-input-card")
export class ToggleInputCard extends LitElement {
  @property({ attribute: false }) labelKey = "";
  @property({ type: Boolean, attribute: false }) checked = false;
  @property({ attribute: false }) inputId?: string;
  @property({ attribute: false }) inputType = "number";
  @property({ attribute: false }) inputMin?: number | string;
  @property({ attribute: false }) inputMax?: number | string;
  @property({ attribute: false }) inputStep?: number | string;
  @property({ attribute: false }) inputValue?: number | string;
  @property({ attribute: false }) inputAriaLabel?: string;
  @property({ attribute: false }) inputPlaceholder?: string;
  @property({ attribute: false }) defaultInputValue?: number | string;
  @property({ attribute: false }) minValidOnEnable?: number;
  @property({ attribute: false }) onToggle?: (
    checked: boolean,
    value: number | string | undefined,
  ) => void;
  @property({ attribute: false }) onInput?: (e: Event) => void;
  @property({ attribute: false }) onChange?: (e: Event) => void;
  @property({ attribute: false }) onKeyDown?: (e: KeyboardEvent) => void;
  @property({ type: Boolean, attribute: false }) disabledCheckbox = false;
  @property({ attribute: false }) disabledMessage = "";
  @property({ attribute: false }) inputLabel = "";

  createRenderRoot() {
    return this;
  }

  protected updated(changedProperties: PropertyValues<this>) {
    if (!changedProperties.has("checked")) return;
    const previousChecked = changedProperties.get("checked");
    if (previousChecked === false && this.checked) {
      const input = this.querySelector("input");
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  private toOptionalNumber(
    value: number | string | undefined,
  ): number | undefined {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    return undefined;
  }

  private resolveValueOnEnable(): number | string | undefined {
    const currentValue = this.inputValue;

    if (
      currentValue === undefined ||
      currentValue === null ||
      currentValue === ""
    ) {
      return this.defaultInputValue;
    }

    if (this.minValidOnEnable === undefined) {
      return currentValue;
    }

    const numericValue = this.toOptionalNumber(currentValue);
    if (numericValue === undefined || numericValue < this.minValidOnEnable) {
      return this.defaultInputValue;
    }

    return numericValue;
  }

  private emitToggle() {
    const nextChecked = !this.checked;
    const nextValue = nextChecked ? this.resolveValueOnEnable() : undefined;
    this.onToggle?.(nextChecked, nextValue);
  }

  private handleCardClick = () => {
    if (this.disabledCheckbox) return;
    this.emitToggle();
  };

  render() {
    const effectiveActive = this.checked && !this.disabledCheckbox;
    const showDisabledMsg = this.disabledCheckbox && !!this.disabledMessage;
    const showOverlay = effectiveActive || showDisabledMsg;

    return html`
      <div class="${cardClass(effectiveActive, "relative overflow-hidden")}">
        <button
          type="button"
          aria-pressed=${effectiveActive}
          @click=${this.handleCardClick}
          class="w-full h-full p-3 flex flex-col items-center justify-between gap-2 focus:outline-none${
            this.disabledCheckbox ? " cursor-not-allowed" : ""
          }"
        >
          <div
            class="w-5 h-5 rounded border flex items-center justify-center transition-colors mt-1 ${
              this.disabledCheckbox
                ? "border-white/10 bg-white/5"
                : this.checked
                  ? "bg-blue-500 border-blue-500"
                  : "border-white/20 bg-white/5"
            }"
          >
            ${effectiveActive
              ? html`<svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-3 w-3 text-white"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fill-rule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clip-rule="evenodd"
                  />
                </svg>`
              : ""}
          </div>

          ${showOverlay
            ? html`<div class="h-[30px] my-1"></div>`
            : html`<div class="h-[2px] w-4 rounded my-3 bg-white/10"></div>`}

          <span
            class="${CARD_LABEL_CLASS} text-center ${effectiveActive
              ? "text-white"
              : "text-white/60"}"
          >
            ${translateText(this.labelKey)}
          </span>
        </button>

        ${effectiveActive
          ? html`
              <div
                class="absolute left-3 right-3 top-1/2 -translate-y-1/2 z-10"
              >
                ${this.inputLabel
                  ? html`<p
                      class="text-white/60 text-[10px] uppercase font-bold tracking-wider text-center mb-1"
                    >
                      ${this.inputLabel}
                    </p>`
                  : nothing}
                <input
                  type=${this.inputType}
                  id=${this.inputId ?? nothing}
                  min=${this.inputMin ?? nothing}
                  max=${this.inputMax ?? nothing}
                  step=${this.inputStep ?? nothing}
                  .value=${String(this.inputValue ?? "")}
                  class=${INPUT_CLASS}
                  aria-label=${this.inputAriaLabel ?? nothing}
                  placeholder=${this.inputPlaceholder ?? nothing}
                  @input=${this.onInput}
                  @change=${this.onChange}
                  @keydown=${this.onKeyDown}
                />
              </div>
            `
          : showDisabledMsg
            ? html`
                <div
                  class="absolute left-3 right-3 top-1/2 -translate-y-1/2 z-10 pointer-events-none"
                >
                  <p
                    class="text-white/35 text-[10px] text-center leading-tight italic"
                  >
                    ${this.disabledMessage}
                  </p>
                </div>
              `
            : nothing}
      </div>
    `;
  }
}
