"use client";

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { type UserSchema } from "@insforge/sdk";
import { insforge } from "./insforge-client";

type TodoRecord = {
  id: string;
  text: string;
  created_at: string;
  is_completed: boolean;
  file_url: string | null;
  file_key: string | null;
  user_id: string;
};

type UploadedAttachment = {
  url: string;
  key: string;
};

type AuthMode = "sign-in" | "sign-up";

type GeneratedTodoPayload = {
  todo_items?: unknown;
  todos?: unknown;
  tasks?: unknown;
  items?: unknown;
};

const panelClassName =
  "rounded-[28px] border border-white/10 bg-white/6 p-6 shadow-[0_24px_80px_rgba(2,8,23,0.45)] backdrop-blur-xl sm:p-8";

const fieldClassName =
  "w-full rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-50 outline-none transition placeholder:text-slate-400 focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20";

const composerFieldClassName = `${fieldClassName} min-h-[120px] resize-none`;

const buttonBaseClassName =
  "inline-flex items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-cyan-400/30 disabled:cursor-not-allowed disabled:opacity-60";

const ghostButtonClassName =
  "inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:border-white/20 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 disabled:cursor-not-allowed disabled:opacity-60";

const todoSelection = "id, text, created_at, is_completed, file_url, file_key, user_id";

const taskGenerationModelId = "deepseek/deepseek-v3.2";

const aiNoContentMessage = "The AI returned no content.";

const taskGenerationSystemPrompt = [
  "You convert natural language requests into concise todo items for a personal task app.",
  'Return JSON only in the exact shape: {"todo_items":["Task 1","Task 2"]}.',
  "Rules:",
  "- Generate 1 to 8 actionable tasks.",
  "- Keep each task short, specific, and independent.",
  "- If the request is already a single task, return one item.",
  "- Do not include markdown, numbering, code fences, or extra keys.",
].join(" ");

function normalizeTodoText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractJsonPayload(rawContent: string): string | null {
  const trimmedContent = rawContent.trim();

  if (!trimmedContent) {
    return null;
  }

  const fencedJsonMatch = trimmedContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedJsonMatch?.[1]) {
    return fencedJsonMatch[1].trim();
  }

  const firstBraceIndex = trimmedContent.indexOf("{");
  const lastBraceIndex = trimmedContent.lastIndexOf("}");

  if (firstBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
    return trimmedContent.slice(firstBraceIndex, lastBraceIndex + 1);
  }

  return trimmedContent;
}

function getTodoTextFromGeneratedItem(item: unknown): string {
  if (typeof item === "string") {
    return normalizeTodoText(item);
  }

  if (item && typeof item === "object") {
    const candidateObject = item as Record<string, unknown>;
    const textLikeKeys = ["text", "title", "name", "content", "label"];

    for (const key of textLikeKeys) {
      const candidateText = candidateObject[key];

      if (typeof candidateText === "string") {
        return normalizeTodoText(candidateText);
      }
    }
  }

  return "";
}

function parseTodoTextsFromPlainContent(rawContent: string): string[] {
  const normalizedLines = rawContent
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizeTodoText(line.replace(/^(?:[-*•]+|\d+[).\]]+)\s*/, "")))
    .filter((line) => line.length > 0);

  const candidateTexts = normalizedLines.length > 1 ? normalizedLines : [normalizeTodoText(rawContent)];

  const uniqueTodoTexts: string[] = [];
  const seenTodoTexts = new Set<string>();

  for (const candidateText of candidateTexts) {
    if (!candidateText) {
      continue;
    }

    const normalizedKey = candidateText.toLowerCase();

    if (seenTodoTexts.has(normalizedKey)) {
      continue;
    }

    seenTodoTexts.add(normalizedKey);
    uniqueTodoTexts.push(candidateText);
  }

  return uniqueTodoTexts.slice(0, 8);
}

function parseGeneratedTodoTexts(rawContent: string): string[] {
  const jsonPayload = extractJsonPayload(rawContent);

  if (!jsonPayload) {
    throw new Error(aiNoContentMessage);
  }

  let parsedContent: GeneratedTodoPayload;

  try {
    parsedContent = JSON.parse(jsonPayload) as GeneratedTodoPayload;
  } catch {
    return parseTodoTextsFromPlainContent(rawContent);
  }

  const candidateItems = Array.isArray(parsedContent.todo_items)
    ? parsedContent.todo_items
    : Array.isArray(parsedContent.todos)
      ? parsedContent.todos
    : Array.isArray(parsedContent.tasks)
      ? parsedContent.tasks
      : Array.isArray(parsedContent.items)
        ? parsedContent.items
        : [];

  const todoTexts = candidateItems
    .map(getTodoTextFromGeneratedItem)
    .filter((text) => text.length > 0);

  const uniqueTodoTexts: string[] = [];
  const seenTodoTexts = new Set<string>();

  for (const todoText of todoTexts) {
    const normalizedKey = todoText.toLowerCase();

    if (seenTodoTexts.has(normalizedKey)) {
      continue;
    }

    seenTodoTexts.add(normalizedKey);
    uniqueTodoTexts.push(todoText);
  }

  if (uniqueTodoTexts.length > 0) {
    return uniqueTodoTexts.slice(0, 8);
  }

  return parseTodoTextsFromPlainContent(rawContent);
}

function createOptimisticTodo(text: string, userId: string, attachment: UploadedAttachment | null): TodoRecord {
  return {
    id: crypto.randomUUID(),
    text,
    created_at: new Date().toISOString(),
    is_completed: false,
    file_url: attachment?.url ?? null,
    file_key: attachment?.key ?? null,
    user_id: userId,
  };
}

const attachmentBucketName = "todo-attachments";

function getDisplayName(user: UserSchema | null): string {
  if (!user) {
    return "";
  }

  const profileName = user.profile?.name?.trim();
  if (profileName) {
    return profileName;
  }

  return user.email.split("@")[0] ?? user.email;
}

export function TodoApp({ dashboardUrl }: { dashboardUrl: string }) {
  const [currentUser, setCurrentUser] = useState<UserSchema | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [isResendingCode, setIsResendingCode] = useState(false);
  const [todos, setTodos] = useState<TodoRecord[]>([]);
  const [todoInput, setTodoInput] = useState("");
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [todoError, setTodoError] = useState<string | null>(null);
  const [isTodoLoading, setIsTodoLoading] = useState(false);
  const [isTodoSaving, setIsTodoSaving] = useState(false);
  const [isAiGenerating, setIsAiGenerating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const { data, error } = await insforge.auth.getCurrentUser();

      if (cancelled) {
        return;
      }

      const isAnonymousSessionError =
        error &&
        (error.message === "No refresh token provided" || error.statusCode === 401);

      if (error && !isAnonymousSessionError) {
        setAuthError(error.message);
      }

      setCurrentUser(data?.user ?? null);
      setIsRestoringSession(false);
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentUser) {
      setTodos([]);
      setIsTodoLoading(false);
      return;
    }

    let cancelled = false;

    async function loadTodos() {
      setIsTodoLoading(true);
      setTodoError(null);

      const { data, error } = await insforge.database
        .from("todo")
        .select(todoSelection)
        .order("created_at", { ascending: false });

      if (cancelled) {
        return;
      }

      if (error) {
        setTodoError(error.message);
        setTodos([]);
      } else {
        setTodos((data ?? []) as TodoRecord[]);
      }

      setIsTodoLoading(false);
    }

    void loadTodos();

    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  function clearAuthFeedback() {
    setAuthError(null);
    setAuthMessage(null);
  }

  function handleAuthModeChange(nextMode: AuthMode) {
    setAuthMode(nextMode);
    setPendingVerification(false);
    setVerificationCode("");
    clearAuthFeedback();
  }

  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    setAttachmentFile(event.target.files?.[0] ?? null);
  }

  function handleClearAttachment() {
    setAttachmentFile(null);

    if (attachmentInputRef.current) {
      attachmentInputRef.current.value = "";
    }
  }

  async function handleOAuthSignIn() {
    clearAuthFeedback();
    setIsAuthSubmitting(true);

    const { data, error } = await insforge.auth.signInWithOAuth({
      provider: "google",
      redirectTo: window.location.origin,
      skipBrowserRedirect: true,
    });

    if (error) {
      setAuthError(error.message);
      setIsAuthSubmitting(false);
      return;
    }

    if (data?.url) {
      window.location.assign(data.url);
      return;
    }

    setIsAuthSubmitting(false);
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearAuthFeedback();

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPassword = password.trim();

    if (!normalizedEmail || !normalizedPassword) {
      setAuthError("Email and password are required.");
      return;
    }

    setIsAuthSubmitting(true);

    if (authMode === "sign-up") {
      const { data, error } = await insforge.auth.signUp({
        email: normalizedEmail,
        password: normalizedPassword,
        name: displayName.trim() || undefined,
      });

      if (error) {
        setAuthError(error.message);
        setIsAuthSubmitting(false);
        return;
      }

      if (data?.requireEmailVerification) {
        setVerificationEmail(normalizedEmail);
        setPendingVerification(true);
        setVerificationCode("");
        setAuthMessage("We sent a 6-digit verification code to your inbox.");
        setIsAuthSubmitting(false);
        return;
      }

      if (data?.user) {
        setCurrentUser(data.user);
        setAuthMessage("Your account is ready.");
        setPendingVerification(false);
        setVerificationCode("");
      } else {
        setAuthMessage("Your account was created.");
      }

      setDisplayName("");
      setPassword("");
      setIsAuthSubmitting(false);
      return;
    }

    const { data, error } = await insforge.auth.signInWithPassword({
      email: normalizedEmail,
      password: normalizedPassword,
    });

    if (error) {
      setAuthError(error.message);
      setIsAuthSubmitting(false);
      return;
    }

    if (data?.user) {
      setCurrentUser(data.user);
      setPendingVerification(false);
      setVerificationCode("");
      setDisplayName("");
      setPassword("");
      setAuthMessage("Signed in successfully.");
    }

    setIsAuthSubmitting(false);
  }

  async function handleVerifyEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearAuthFeedback();

    const normalizedEmail = verificationEmail.trim().toLowerCase();
    const normalizedCode = verificationCode.trim();

    if (!normalizedEmail || !normalizedCode) {
      setAuthError("Enter the email address and 6-digit code.");
      return;
    }

    setIsAuthSubmitting(true);

    const { data, error } = await insforge.auth.verifyEmail({
      email: normalizedEmail,
      otp: normalizedCode,
    });

    if (error) {
      setAuthError(error.message);
      setIsAuthSubmitting(false);
      return;
    }

    if (data?.user) {
      setCurrentUser(data.user);
      setAuthMode("sign-in");
      setPendingVerification(false);
      setVerificationCode("");
      setPassword("");
      setDisplayName("");
      setAuthMessage("Email verified. You are now signed in.");
    }

    setIsAuthSubmitting(false);
  }

  async function handleResendVerificationCode() {
    const normalizedEmail = verificationEmail.trim().toLowerCase();

    if (!normalizedEmail) {
      setAuthError("Add the email address first.");
      return;
    }

    clearAuthFeedback();
    setIsResendingCode(true);

    const { error } = await insforge.auth.resendVerificationEmail({
      email: normalizedEmail,
    });

    if (error) {
      setAuthError(error.message);
    } else {
      setAuthMessage(`A new verification code was sent to ${normalizedEmail}.`);
    }

    setIsResendingCode(false);
  }

  async function persistTodos(
    nextTodoTexts: string[],
    restoreInputText: string,
    attachment: UploadedAttachment | null = null
  ) {
    if (!currentUser) {
      setTodoError("Sign in to create todos.");
      return false;
    }

    const normalizedTodoTexts = nextTodoTexts
      .map(normalizeTodoText)
      .filter((text) => text.length > 0);

    if (normalizedTodoTexts.length === 0) {
      setTodoError("Add a task or describe a project first.");
      return false;
    }

    setTodoError(null);

    const optimisticTodos = normalizedTodoTexts.map((text) =>
      createOptimisticTodo(text, currentUser.id, attachment)
    );
    const optimisticTodoIds = new Set(optimisticTodos.map((todo) => todo.id));

    setTodos((previousTodos) => [...optimisticTodos, ...previousTodos]);
    setTodoInput("");

    const { data, error } = await insforge.database
      .from("todo")
      .insert(
        normalizedTodoTexts.map((text) => ({
          text,
          file_url: attachment?.url ?? null,
          file_key: attachment?.key ?? null,
        }))
      )
      .select(todoSelection);

    if (error || !data?.length || data.length !== optimisticTodos.length) {
      setTodos((previousTodos) =>
        previousTodos.filter((todo) => !optimisticTodoIds.has(todo.id))
      );
      setTodoInput(restoreInputText);

      if (attachment?.key) {
        await insforge.storage.from(attachmentBucketName).remove(attachment.key);
      }

      setTodoError(error?.message ?? "Could not save the todo.");
      return false;
    }

    const replacementTodosById = new Map(
      optimisticTodos.map((todo, index) => [todo.id, data[index] as TodoRecord])
    );

    setTodos((previousTodos) =>
      previousTodos.map((todo) => replacementTodosById.get(todo.id) ?? todo)
    );

    setTodoInput("");
    return true;
  }

  async function handleSignOut() {
    clearAuthFeedback();

    const { error } = await insforge.auth.signOut();

    if (error) {
      setAuthError(error.message);
      return;
    }

    setCurrentUser(null);
    setTodos([]);
    setTodoInput("");
    setTodoError(null);
    setPendingVerification(false);
    setVerificationCode("");
    setVerificationEmail("");
    setDisplayName("");
    setPassword("");
    handleClearAttachment();
  }

  async function handleAddTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!currentUser) {
      setTodoError("Sign in to create todos.");
      return;
    }

    const trimmedText = normalizeTodoText(todoInput);

    if (!trimmedText) {
      return;
    }

    setTodoError(null);
    setIsTodoSaving(true);

    const fileToUpload = attachmentFile;
    let uploadedAttachment: UploadedAttachment | null = null;

    try {
      if (fileToUpload) {
        const { data, error } = await insforge.storage
          .from(attachmentBucketName)
          .uploadAuto(fileToUpload);

        if (error || !data) {
          setTodoError(error?.message ?? "Could not upload the attachment.");
          return;
        }

        uploadedAttachment = data;
      }

      const persisted = await persistTodos([trimmedText], trimmedText, uploadedAttachment);

      if (persisted) {
        handleClearAttachment();
      }
    } catch (unexpectedError) {
      setTodoError(
        unexpectedError instanceof Error ? unexpectedError.message : "Could not save the todo."
      );
    } finally {
      setIsTodoSaving(false);
    }
  }

  async function handleGenerateTodos() {
    if (!currentUser) {
      setTodoError("Sign in to create todos.");
      return;
    }

    if (attachmentFile) {
      setTodoError("Remove the attachment before using AI generation.");
      return;
    }

    const promptText = normalizeTodoText(todoInput);

    if (!promptText) {
      setTodoError("Describe a task or project first.");
      return;
    }

    setTodoError(null);
    setIsAiGenerating(true);

    try {
      const completion = await insforge.ai.chat.completions.create({
        model: taskGenerationModelId,
        messages: [
          {
            role: "system",
            content: taskGenerationSystemPrompt,
          },
          {
            role: "user",
            content: `Break this request into todo items: ${promptText}`,
          },
        ],
        temperature: 0.2,
        maxTokens: 400,
      });

      const generatedContent = completion?.choices?.[0]?.message?.content;

      if (typeof generatedContent !== "string" || !generatedContent.trim()) {
        setTodoError(aiNoContentMessage);
        return;
      }

      const generatedTodoTexts = parseGeneratedTodoTexts(generatedContent);

      if (!generatedTodoTexts.length) {
        setTodoError(aiNoContentMessage);
        return;
      }

      setIsTodoSaving(true);
      await persistTodos(generatedTodoTexts, promptText);
    } catch (caughtError) {
      setTodoError(aiNoContentMessage);
    } finally {
      setIsTodoSaving(false);
      setIsAiGenerating(false);
    }
  }

  async function handleToggleTodo(todoId: string, currentValue: boolean) {
    if (!currentUser) {
      return;
    }

    const nextValue = !currentValue;
    setTodoError(null);
    setTodos((previousTodos) =>
      previousTodos.map((todo) =>
        todo.id === todoId ? { ...todo, is_completed: nextValue } : todo
      )
    );

    const { error } = await insforge.database
      .from("todo")
      .update({ is_completed: nextValue })
      .eq("id", todoId);

    if (error) {
      setTodoError(error.message);
      setTodos((previousTodos) =>
        previousTodos.map((todo) =>
          todo.id === todoId ? { ...todo, is_completed: currentValue } : todo
        )
      );
    }
  }

  const displayNameForUser = getDisplayName(currentUser);
  const featurePills = [
    "Email sign-up with verification code",
    "Google OAuth",
    "AI task generation",
    "Task attachments in InsForge Storage",
  ];

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#050816] px-4 py-6 text-slate-50 sm:px-6 lg:px-8 lg:py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(6,182,212,0.24),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(14,165,233,0.18),_transparent_22%),linear-gradient(180deg,_rgba(2,6,23,0.92),_rgba(3,7,18,1))]" />
      <div className="pointer-events-none absolute left-1/2 top-24 h-72 w-72 -translate-x-1/2 rounded-full bg-cyan-500/10 blur-3xl" />

      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl items-center">
        <div className="grid w-full gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8">
          <section className={`${panelClassName} relative overflow-hidden`}>
            <div className="absolute right-0 top-0 h-40 w-40 rounded-full bg-cyan-400/10 blur-3xl" />
            <div className="absolute -bottom-12 left-4 h-32 w-32 rounded-full bg-sky-500/10 blur-3xl" />

            <div className="relative flex h-full flex-col justify-between gap-8">
              <div className="space-y-6">
                <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-100">
                  InsForge Auth + AI Gateway
                </div>

                <div className="space-y-4">
                  <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
                    Signed-in todo lists with AI task breakdown built in.
                  </h1>
                  <p className="max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
                    Email sign-up, Google OAuth, per-user records, and task attachments powered by InsForge Auth and Storage.
                    Type a plain-language request and the app can split it into one or more todos through the InsForge AI Gateway.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {featurePills.map((pill) => (
                  <div
                    key={pill}
                    className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200"
                  >
                    {pill}
                  </div>
                ))}
              </div>

              <a
                href={dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-cyan-200 underline decoration-cyan-400/40 decoration-2 underline-offset-4 transition hover:text-cyan-100"
              >
                Open the backend dashboard
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          </section>

          <section className={`${panelClassName} relative`}>
            {isRestoringSession ? (
              <div className="flex min-h-[520px] items-center justify-center text-sm text-slate-300">
                Restoring your session...
              </div>
            ) : currentUser ? (
              <div className="flex min-h-[520px] flex-col gap-6">
                <div className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200">
                      Your workspace
                    </p>
                    <h2 className="text-2xl font-semibold text-white">
                      Welcome, {displayNameForUser}
                    </h2>
                    <p className="text-sm text-slate-300">
                      Only your session can create, read, and update these todos.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleSignOut}
                    className={ghostButtonClassName}
                  >
                    Sign out
                  </button>
                </div>

                <form onSubmit={handleAddTodo} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-slate-200" htmlFor="todo-input">
                      Describe a task or project
                    </label>
                    <textarea
                      id="todo-input"
                      value={todoInput}
                      onChange={(event) => setTodoInput(event.target.value)}
                      placeholder="Example: plan a product launch next week and break it into tasks"
                      rows={4}
                      className={composerFieldClassName}
                    />
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row">
                    <button
                      type="submit"
                      disabled={isTodoSaving || isAiGenerating}
                      className={`${buttonBaseClassName} flex-1 bg-cyan-400 text-slate-950 hover:bg-cyan-300`}
                    >
                      {isTodoSaving ? "Saving..." : "Add one task"}
                    </button>
                    <button
                      type="button"
                      onClick={handleGenerateTodos}
                      disabled={isTodoSaving || isAiGenerating || !todoInput.trim() || Boolean(attachmentFile)}
                      className={`${ghostButtonClassName} flex-1`}
                    >
                      {isAiGenerating ? "Generating..." : "Generate with AI"}
                    </button>
                  </div>

                  <p className="text-xs text-slate-400">
                    Use a short task for manual entry, or describe a bigger goal and let AI turn it into a checklist.
                    {attachmentFile ? " Remove the attachment to enable AI generation." : ""}
                  </p>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-slate-200">Attachment (optional)</span>
                    <input
                      id="todo-file"
                      ref={attachmentInputRef}
                      type="file"
                      onChange={handleAttachmentChange}
                      className="block w-full cursor-pointer rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300 outline-none transition file:mr-4 file:rounded-2xl file:border-0 file:bg-cyan-400 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950 file:transition hover:border-cyan-400/40 hover:file:bg-cyan-300 focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20"
                    />
                  </label>

                  {attachmentFile ? (
                    <div className="flex items-center justify-between gap-3 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-cyan-50">Selected file</p>
                        <p className="truncate text-xs text-cyan-50/80">{attachmentFile.name}</p>
                      </div>

                      <button
                        type="button"
                        onClick={handleClearAttachment}
                        className={ghostButtonClassName}
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}

                  {todoError ? (
                    <p className="text-sm text-rose-300" role="alert">
                      {todoError}
                    </p>
                  ) : null}
                </form>

                <div className="flex min-h-0 flex-1 flex-col gap-4">
                  <div className="flex items-center justify-between text-sm text-slate-300">
                    <span>{todos.length} visible records</span>
                    {isTodoLoading ? <span>Loading...</span> : null}
                  </div>

                  {todos.length === 0 && !isTodoLoading ? (
                    <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-white/10 bg-slate-950/30 p-8 text-center text-sm text-slate-300">
                      Your list is empty. Add a task or let AI turn a bigger goal into a checklist.
                    </div>
                  ) : (
                    <ul className="flex max-h-[360px] flex-col gap-3 overflow-auto pr-1">
                      {todos.map((todo) => (
                        <li
                          key={todo.id}
                          className="flex items-start gap-3 rounded-3xl border border-white/10 bg-slate-950/35 px-4 py-3"
                        >
                          <button
                            type="button"
                            onClick={() => handleToggleTodo(todo.id, todo.is_completed)}
                            aria-label={todo.is_completed ? `Mark ${todo.text} as incomplete` : `Mark ${todo.text} as complete`}
                            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition ${
                              todo.is_completed
                                ? "border-emerald-400 bg-emerald-400"
                                : "border-slate-500 hover:border-cyan-300"
                            }`}
                          >
                            {todo.is_completed ? (
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="white"
                                strokeWidth="3"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : null}
                          </button>

                          <div className="min-w-0 flex-1 space-y-1">
                            <p
                              className={`text-sm font-medium ${
                                todo.is_completed ? "text-slate-400 line-through" : "text-white"
                              }`}
                            >
                              {todo.text}
                            </p>

                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                              <span>{new Date(todo.created_at).toLocaleString()}</span>
                              {todo.file_url ? (
                                <a
                                  href={todo.file_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`Open attachment for ${todo.text}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-0.5 font-medium text-cyan-100 transition hover:border-cyan-300/40 hover:bg-cyan-400/15"
                                >
                                  <span className="max-w-[10rem] truncate">
                                    {todo.file_key?.split("/").pop() ?? "Open attachment"}
                                  </span>
                                  <span aria-hidden="true">↗</span>
                                </a>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <p className="text-xs text-slate-400">
                  Todo records are filtered by your authenticated user id at the database level.
                </p>
              </div>
            ) : (
              <div className="flex min-h-[520px] flex-col gap-6">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200">
                    Secure access
                  </p>
                  <h2 className="text-2xl font-semibold text-white">
                    {pendingVerification ? "Verify your email" : authMode === "sign-up" ? "Create your account" : "Sign in to continue"}
                  </h2>
                  <p className="text-sm text-slate-300">
                    Sign in with email/password or use Google OAuth. New sign-ups must verify their email code before they can use the app.
                  </p>
                </div>

                {pendingVerification ? (
                  <form onSubmit={handleVerifyEmail} className="space-y-4">
                    <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-50">
                      A 6-digit code was sent to {verificationEmail || email || "your email address"}.
                    </div>

                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-slate-200">Email</span>
                      <input
                        type="email"
                        value={verificationEmail}
                        onChange={(event) => setVerificationEmail(event.target.value)}
                        placeholder="you@example.com"
                        className={fieldClassName}
                      />
                    </label>

                    <label className="block space-y-2">
                      <span className="text-sm font-medium text-slate-200">Verification code</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={verificationCode}
                        onChange={(event) => setVerificationCode(event.target.value)}
                        placeholder="123456"
                        className={fieldClassName}
                      />
                    </label>

                    {authError ? (
                      <p className="text-sm text-rose-300" role="alert">
                        {authError}
                      </p>
                    ) : null}

                    {authMessage ? (
                      <p className="text-sm text-emerald-300" role="status">
                        {authMessage}
                      </p>
                    ) : null}

                    <div className="flex flex-col gap-3 sm:flex-row">
                      <button
                        type="submit"
                        disabled={isAuthSubmitting}
                        className={`${buttonBaseClassName} flex-1 bg-cyan-400 text-slate-950 hover:bg-cyan-300`}
                      >
                        {isAuthSubmitting ? "Verifying..." : "Verify email"}
                      </button>
                      <button
                        type="button"
                        onClick={handleResendVerificationCode}
                        disabled={isResendingCode}
                        className={`${ghostButtonClassName} flex-1`}
                      >
                        {isResendingCode ? "Sending..." : "Resend code"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-white/5 p-1">
                      <button
                        type="button"
                        onClick={() => handleAuthModeChange("sign-in")}
                        className={`${buttonBaseClassName} ${
                          authMode === "sign-in"
                            ? "bg-white text-slate-950"
                            : "text-slate-300 hover:bg-white/5"
                        }`}
                      >
                        Sign in
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAuthModeChange("sign-up")}
                        className={`${buttonBaseClassName} ${
                          authMode === "sign-up"
                            ? "bg-white text-slate-950"
                            : "text-slate-300 hover:bg-white/5"
                        }`}
                      >
                        Sign up
                      </button>
                    </div>

                    <form onSubmit={handleAuthSubmit} className="space-y-4">
                      {authMode === "sign-up" ? (
                        <label className="block space-y-2">
                          <span className="text-sm font-medium text-slate-200">Display name</span>
                          <input
                            type="text"
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            placeholder="Jane Doe"
                            className={fieldClassName}
                          />
                        </label>
                      ) : null}

                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-slate-200">Email</span>
                        <input
                          type="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          placeholder="you@example.com"
                          className={fieldClassName}
                        />
                      </label>

                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-slate-200">Password</span>
                        <input
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder="••••••••"
                          className={fieldClassName}
                        />
                      </label>

                      {authError ? (
                        <p className="text-sm text-rose-300" role="alert">
                          {authError}
                        </p>
                      ) : null}

                      {authMessage ? (
                        <p className="text-sm text-emerald-300" role="status">
                          {authMessage}
                        </p>
                      ) : null}

                      <div className="flex flex-col gap-3 sm:flex-row">
                        <button
                          type="submit"
                          disabled={isAuthSubmitting}
                          className={`${buttonBaseClassName} flex-1 bg-cyan-400 text-slate-950 hover:bg-cyan-300`}
                        >
                          {isAuthSubmitting
                            ? authMode === "sign-in"
                              ? "Signing in..."
                              : "Creating account..."
                            : authMode === "sign-in"
                              ? "Sign in with email"
                              : "Sign up with email"}
                        </button>

                        <button
                          type="button"
                          onClick={handleOAuthSignIn}
                          disabled={isAuthSubmitting}
                          className={`${ghostButtonClassName} flex-1`}
                        >
                          Continue with Google
                        </button>
                      </div>
                    </form>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
