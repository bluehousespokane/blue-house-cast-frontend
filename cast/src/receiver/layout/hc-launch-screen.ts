import type { PropertyValues, TemplateResult } from "lit";
import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators";
import { fireEvent } from "../../../../src/common/dom/fire_event";
import type { HomeAssistant } from "../../../../src/types";

@customElement("hc-launch-screen")
class HcLaunchScreen extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @property() public error?: string;

  protected render(): TemplateResult {
    return html`
      <div class="container">
        ${
          this.error
            ? html`<div class="status" role="status">${this.error}</div>`
            : ""
        }
      </div>
    `;
  }

  protected updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    if (changedProperties.has("error") && this.error) {
      fireEvent(this, "cast-loading-error");
    }
  }

  static styles = css`
    :host {
      display: block;
      height: 100vh;
      background-color: #000;
      font-size: var(--ha-font-size-2xl);
    }
    .container {
      display: flex;
      text-align: center;
      align-items: center;
      height: 100%;
      justify-content: center;
    }
    .status {
      color: #d4d4d4;
    }
  `;
}

declare global {
  interface HASSDomEvents {
    "cast-loading-error": undefined;
  }

  interface HTMLElementTagNameMap {
    "hc-launch-screen": HcLaunchScreen;
  }
}
