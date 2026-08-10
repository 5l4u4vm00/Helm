// Workspace recipe editor: the env vars and startup command that new sessions
// in this workspace inherit. Structure mirrors CommandPalette / SettingsDialog
// (backdrop + centered dialog, Esc / backdrop click closes and restores focus).
//
// Editing state is local and only committed on save: a recipe is a launch
// contract, and a half-typed env key must not reach the store where the next
// new session would pick it up.
import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "../../store/workspaces";
import {
  isReservedEnvKey,
  isValidEnvKey,
  RESERVED_ENV_KEYS,
  type WorkspaceRecipe,
} from "../../store/workspaceGroups";
import { handleDismissKey, trapTabKey } from "../../focus/focusUtils";
import { useT } from "../../i18n";
import "./WorkspaceRecipeDialog.css";

interface Props {
  workspaceId: string;
  /** Restores focus to the opener; the caller owns where that is. */
  onClose: () => void;
}

/** One editable row. `id` keeps React keys stable while the key text changes —
 *  keying on the env name itself would remount the input on every keystroke
 *  and lose the caret. */
interface EnvRow {
  id: string;
  key: string;
  value: string;
}

function toRows(env: Record<string, string> | undefined): EnvRow[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value,
  }));
}

/** Per-row validation message key, or undefined when the row is fine.
 *  Blank rows are ignored rather than flagged — an empty trailing row is how
 *  you start typing a new one, not an error. */
function rowError(row: EnvRow, rows: EnvRow[], windows: boolean): string | undefined {
  const key = row.key.trim();
  if (key === "") return row.value.trim() === "" ? undefined : "workspaceRecipe.errorNoKey";
  if (!isValidEnvKey(key)) return "workspaceRecipe.errorBadKey";
  if (isReservedEnvKey(key, windows)) return "workspaceRecipe.errorReservedKey";
  const duplicate = rows.some((r) => r.id !== row.id && r.key.trim() === key);
  return duplicate ? "workspaceRecipe.errorDuplicateKey" : undefined;
}

export function WorkspaceRecipeDialog({ workspaceId, onClose }: Props) {
  const t = useT();
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const setWorkspaceRecipe = useWorkspaceStore((s) => s.setWorkspaceRecipe);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<EnvRow[]>(() => toRows(workspace?.recipe?.env));
  const [command, setCommand] = useState(workspace?.recipe?.command ?? "");

  const windows = useMemo(() => navigator.platform.startsWith("Win"), []);
  const errors = useMemo(
    () => rows.map((r) => rowError(r, rows, windows)),
    [rows, windows],
  );
  const hasError = errors.some(Boolean);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  // The workspace can be deleted while this dialog is open (sidebar × or a
  // command); without this the dialog would keep editing a recipe with nowhere
  // to save it.
  useEffect(() => {
    if (!workspace) onClose();
  }, [workspace, onClose]);
  if (!workspace) return null;

  const updateRow = (id: string, patch: Partial<EnvRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const save = () => {
    if (hasError) return;
    const env: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key !== "") env[key] = row.value;
    }
    const recipe: WorkspaceRecipe = {};
    if (Object.keys(env).length > 0) recipe.env = env;
    if (command.trim() !== "") recipe.command = command.trim();
    // The store normalizes again and turns an empty recipe into undefined.
    setWorkspaceRecipe(workspaceId, recipe);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (handleDismissKey(e, onClose)) return;
    if (e.key === "Tab" && dialogRef.current) trapTabKey(e, dialogRef.current);
  };

  return (
    <div className="recipe-overlay">
      <div className="recipe-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        className="recipe-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("workspaceRecipe.dialogLabel", { name: workspace.name })}
        onKeyDown={onKeyDown}
      >
        <div className="recipe-header">
          <h2>{t("workspaceRecipe.title", { name: workspace.name })}</h2>
          <p className="recipe-hint">{t("workspaceRecipe.hint")}</p>
        </div>

        <div className="recipe-body">
          <section className="recipe-section">
            <h3>{t("workspaceRecipe.envHeading")}</h3>
            <p className="recipe-hint">
              {t("workspaceRecipe.envHint", { keys: RESERVED_ENV_KEYS.join(", ") })}
            </p>
            {rows.length > 0 && (
              <div className="recipe-env-rows">
                {rows.map((row, i) => (
                  <div key={row.id} className="recipe-env-row">
                    <input
                      ref={i === 0 ? firstFieldRef : undefined}
                      className="recipe-env-key"
                      value={row.key}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={t("workspaceRecipe.envKeyPlaceholder")}
                      aria-label={t("workspaceRecipe.envKeyPlaceholder")}
                      aria-invalid={errors[i] ? true : undefined}
                      onChange={(e) => updateRow(row.id, { key: e.target.value })}
                    />
                    <input
                      className="recipe-env-value"
                      value={row.value}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={t("workspaceRecipe.envValuePlaceholder")}
                      aria-label={t("workspaceRecipe.envValuePlaceholder")}
                      onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    />
                    <button
                      className="icon-btn"
                      title={t("workspaceRecipe.removeEnv")}
                      aria-label={t("workspaceRecipe.removeEnv")}
                      onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                    >
                      ×
                    </button>
                    {errors[i] && <div className="recipe-error">{t(errors[i])}</div>}
                  </div>
                ))}
              </div>
            )}
            <button
              className="recipe-add-env"
              onClick={() =>
                setRows((prev) => [...prev, { id: crypto.randomUUID(), key: "", value: "" }])
              }
            >
              {t("workspaceRecipe.addEnv")}
            </button>
          </section>

          <section className="recipe-section">
            <h3>{t("workspaceRecipe.commandHeading")}</h3>
            <p className="recipe-hint">{t("workspaceRecipe.commandHint")}</p>
            <input
              className="recipe-command"
              value={command}
              spellCheck={false}
              autoComplete="off"
              placeholder={t("workspaceRecipe.commandPlaceholder")}
              aria-label={t("workspaceRecipe.commandHeading")}
              onChange={(e) => setCommand(e.target.value)}
            />
          </section>
        </div>

        <div className="recipe-footer">
          <button onClick={onClose}>{t("workspaceRecipe.cancel")}</button>
          <button className="primary" disabled={hasError} onClick={save}>
            {t("workspaceRecipe.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
