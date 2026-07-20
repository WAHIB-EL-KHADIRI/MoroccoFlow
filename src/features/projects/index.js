import { appStore } from "../../core/store.js";
import { t } from "../../core/i18n.js";
import { escapeHTML } from "../../core/security.js";
import { formatDate } from "../../shared/formatters.js";
import { icon } from "../../design-system/icons.js";
import { toast } from "../../design-system/components.js";
import { pageHeader, clientName, employeeName, emptyState } from "../shared.js";

const columns = ["todo", "doing", "review", "done"];

class MFProjectsView extends HTMLElement {
  connectedCallback() {
    this.unsubscribe = appStore.subscribe(() => this.render());
    this.onLocale = () => this.render();
    window.addEventListener("mf:locale-change", this.onLocale);
    this.render();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    window.removeEventListener("mf:locale-change", this.onLocale);
  }

  render() {
    const { projects, tasks, clients, employees } = appStore.state.data;
    this.innerHTML = `<section class="page" aria-labelledby="projects-title">
      ${pageHeader({
        eyebrow: "WORKFLOW",
        title: t("projectsTitle"),
        subtitle: `${projects.filter((item) => item.status === "active").length} ${t("activeProjects").toLowerCase()} · ${tasks.filter((item) => item.status !== "done").length} tâches ouvertes`,
        actions: `<button class="button primary" id="add-task">${icon("plus")} ${t("addTask")}</button>`,
      }).replace('class="page-title"', 'class="page-title" id="projects-title"')}

      <div class="toolbar">
        <select class="select" id="project-filter" aria-label="${t("projects")}">
          <option value="">${t("projects")} · Tous</option>
          ${projects.map((project) => `<option value="${project.id}">${escapeHTML(project.name)}</option>`).join("")}
        </select>
        <span class="badge">${tasks.length} tâches</span>
        <span class="toolbar-spacer"></span>
        <span class="muted">${icon("lock")} IndexedDB · auto-save</span>
      </div>

      ${
        tasks.length
          ? `<div class="kanban" aria-label="Kanban board">
              ${columns
                .map((status) => {
                  const statusTasks = tasks.filter((task) => task.status === status);
                  return `<section class="kanban-column" data-status="${status}" aria-labelledby="column-${status}">
                    <div class="kanban-head"><span id="column-${status}">${t(status)}</span><span class="count">${statusTasks.length}</span></div>
                    <div class="kanban-stack">
                      ${statusTasks
                        .map((task) => {
                          const project = projects.find((item) => item.id === task.projectId);
                          const index = columns.indexOf(status);
                          return `<article class="task-card" draggable="true" data-id="${task.id}" tabindex="0">
                            <div style="display:flex;justify-content:space-between;gap:8px">
                              <span class="badge">${escapeHTML(project?.name || "—")}</span>
                              <mf-status-badge status="${task.priority}"></mf-status-badge>
                            </div>
                            <h3 class="task-card-title">${escapeHTML(task.title)}</h3>
                            <div class="task-meta">
                              <span title="${t("assignee")}">${escapeHTML(employeeName(employees, task.assignee).split(" ")[0])}</span>
                              <span>${formatDate(task.dueDate)}</span>
                            </div>
                            <div class="move-controls" aria-label="Move task" style="margin-top:10px;justify-content:flex-end">
                              <button class="mini-button move-task" data-id="${task.id}" data-to="${columns[index - 1] || ""}" ${index === 0 ? "disabled" : ""} aria-label="Move left">${icon("arrowLeft")}</button>
                              <button class="mini-button move-task" data-id="${task.id}" data-to="${columns[index + 1] || ""}" ${index === columns.length - 1 ? "disabled" : ""} aria-label="Move right">${icon("arrowRight")}</button>
                            </div>
                          </article>`;
                        })
                        .join("")}
                    </div>
                  </section>`;
                })
                .join("")}
            </div>`
          : emptyState(
              `<button class="button primary" id="empty-add-task">${t("addTask")}</button>`,
            )
      }

      <dialog id="task-dialog" aria-labelledby="task-dialog-title">
        <form id="task-form">
          <div class="dialog-head"><h2 class="dialog-title" id="task-dialog-title">${t("addTask")}</h2><button type="button" class="icon-button close-dialog" aria-label="${t("close")}">${icon("close")}</button></div>
          <div class="dialog-body form-grid">
            <div class="form-group full"><label for="task-title">${t("name")}</label><input id="task-title" name="title" required minlength="3"></div>
            <div class="form-group"><label for="projectId">${t("projects")}</label><select id="projectId" name="projectId" required>${projects.map((project) => `<option value="${project.id}">${escapeHTML(project.name)} · ${escapeHTML(clientName(clients, project.clientId))}</option>`).join("")}</select></div>
            <div class="form-group"><label for="assignee">${t("assignee")}</label><select id="assignee" name="assignee">${employees.map((employee) => `<option value="${employee.id}">${escapeHTML(employee.name)}</option>`).join("")}</select></div>
            <div class="form-group"><label for="priority">${t("priority")}</label><select id="priority" name="priority"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
            <div class="form-group"><label for="dueDate">${t("dueDate")}</label><input id="dueDate" name="dueDate" type="date" required></div>
          </div>
          <div class="dialog-actions"><button type="button" class="button close-dialog">${t("cancel")}</button><button class="button primary" type="submit">${t("save")}</button></div>
        </form>
      </dialog>
      <p class="footer-credit">Accessible Kanban · Drag, touch & keyboard controls</p>
    </section>`;
    this.bindEvents();
  }

  async moveTask(id, status) {
    if (!status) return;
    const task = appStore.state.data.tasks.find((item) => item.id === id);
    if (!task) return;
    await appStore.save("tasks", { ...task, status });
    toast(t("saved"));
  }

  bindEvents() {
    const dialog = this.querySelector("#task-dialog");
    const open = () => dialog.showModal();
    this.querySelector("#add-task")?.addEventListener("click", open);
    this.querySelector("#empty-add-task")?.addEventListener("click", open);
    this.querySelectorAll(".close-dialog").forEach((button) =>
      button.addEventListener("click", () => dialog.close()),
    );
    this.querySelector("#task-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await appStore.save("tasks", { ...values, status: "todo" });
      dialog.close();
      toast(t("saved"));
    });
    this.querySelectorAll(".move-task").forEach((button) =>
      button.addEventListener("click", () => this.moveTask(button.dataset.id, button.dataset.to)),
    );
    this.querySelectorAll(".task-card").forEach((card) => {
      card.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", card.dataset.id);
        event.dataTransfer.effectAllowed = "move";
      });
    });
    this.querySelectorAll(".kanban-column").forEach((column) => {
      column.addEventListener("dragover", (event) => {
        event.preventDefault();
        column.classList.add("drag-over");
      });
      column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
      column.addEventListener("drop", (event) => {
        event.preventDefault();
        column.classList.remove("drag-over");
        this.moveTask(event.dataTransfer.getData("text/plain"), column.dataset.status);
      });
    });
    this.querySelector("#project-filter")?.addEventListener("change", (event) => {
      const selected = event.target.value;
      this.querySelectorAll(".task-card").forEach((card) => {
        const task = appStore.state.data.tasks.find((item) => item.id === card.dataset.id);
        card.classList.toggle("hidden", Boolean(selected && task.projectId !== selected));
      });
    });
  }
}

customElements.define("mf-projects-view", MFProjectsView);
export const tag = "mf-projects-view";
