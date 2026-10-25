import type { TemplateResult } from "lit";
import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators";
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
  interface HTMLElementTagNameMap {
    "hc-launch-screen": HcLaunchScreen;
  }
}
