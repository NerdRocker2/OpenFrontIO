import { LitElement, PropertyValues, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";
import { CARD_LABEL_CLASS, INPUT_CLASS, cardClass } from "./InputCardStyles";

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
  // Optional hint shown under the input when its value is 0 (e.g. "Disabled"),
  // so a 0 that means "off" isn't cryptic.
  @property({ attribute: false }) zeroLabel?: string;
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

  // Autofocus + select the number input when the card is toggled on. Safe now
  // that the input is always mounted (focusing a freshly-inserted one janked).
  protected updated(changedProperties: PropertyValues<this>) {
    if (!changedProperties.has("checked")) return;
    if (changedProperties.get("checked") === false && this.checked) {
      const input = this.querySelector("input");
      input?.focus();
      input?.select();
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
    return html`
      <div class="${cardClass(this.checked)} relative overflow-hidden">
        <button
          type="button"
          aria-pressed=${effectiveActive}
          @click=${this.handleCardClick}
          class="w-full h-full p-3 flex flex-col items-center justify-between gap-2 focus:outline-none${this.disabledCheckbox ? " cursor-not-allowed" : ""}"
        >
          <div
            class="w-5 h-5 rounded border flex items-center justify-center transition-colors mt-1 ${this.disabledCheckbox
              ? "border-white/10 bg-white/5"
              : this.checked
                ? "bg-blue-500 border-blue-500"
                : "border-white/20 bg-white/5"}"
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

          ${effectiveActive
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

        <!-- Keep the input permanently mounted and just hide it when unchecked.
             CSS-hiding an always-present input avoids jank from focusing a
             freshly-inserted input on enable. -->
        <div
          class="absolute left-3 right-3 top-1/2 -translate-y-1/2 z-10 ${effectiveActive
            ? ""
            : "hidden"}"
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
          ${this.checked &&
          this.zeroLabel !== undefined &&
          this.toOptionalNumber(this.inputValue) === 0
            ? html`<div
                class="pointer-events-none absolute left-0 right-0 top-full mt-0.5 text-center text-[10px] leading-none text-white/70"
              >
                ${this.zeroLabel}
              </div>`
            : nothing}
        </div>
        ${showDisabledMsg
          ? html`<div
              class="absolute left-3 right-3 top-1/2 -translate-y-1/2 z-10 pointer-events-none"
            >
              <p
                class="text-white/35 text-[10px] text-center leading-tight italic"
              >
                ${this.disabledMessage}
              </p>
            </div>`
          : nothing}
      </div>
    `;
  }
}
