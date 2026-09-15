"use client";

import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
} from "react";
import { useRef, useState } from "react";
import { landingFor, type Seat } from "@/lib/seat";
import styles from "./access.module.css";

const CODE_LENGTH = 6;
const EMPTY_CODE = Array<string>(CODE_LENGTH).fill("");

const SEATS: { value: Seat; label: string }[] = [
  { value: "ceo", label: "一号位" },
  { value: "sec", label: "秘书" },
];

function navigationDelay() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 40 : 520;
}

export function AccessForm({
  nextPath,
  initialSeat,
  onUnlock,
}: {
  nextPath: string | null;
  initialSeat: Seat;
  onUnlock: () => void;
}) {
  const [seat, setSeat] = useState<Seat>(initialSeat);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const digitsRef = useRef([...EMPTY_CODE]);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const requestInFlight = useRef(false);
  const seatButtonRefs = useRef<Record<Seat, HTMLButtonElement | null>>({ ceo: null, sec: null });

  function focusDigit(index: number) {
    inputRefs.current[Math.max(0, Math.min(index, CODE_LENGTH - 1))]?.focus();
  }

  function clearCode() {
    const empty = [...EMPTY_CODE];
    digitsRef.current = empty;
    inputRefs.current.forEach((input) => {
      if (input) input.value = "";
    });
    requestAnimationFrame(() => focusDigit(0));
  }

  function handleSeatKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = SEATS.findIndex((option) => option.value === seat);
    let nextIndex: number;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + SEATS.length) % SEATS.length;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % SEATS.length;
    } else {
      return;
    }

    event.preventDefault();
    const nextSeat = SEATS[nextIndex].value;
    setSeat(nextSeat);
    seatButtonRefs.current[nextSeat]?.focus();
  }

  async function verify(candidate: string) {
    if (candidate.length !== CODE_LENGTH || requestInFlight.current) return;
    requestInFlight.current = true;
    setError("");
    setSubmitting(true);

    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: candidate, seat }),
      });

      if (response.ok) {
        onUnlock();
        await new Promise((resolve) => window.setTimeout(resolve, navigationDelay()));
        const destination = nextPath ?? landingFor(seat);
        window.location.replace(destination === "/" ? "/?_entry=unlock" : destination);
        return;
      }

      setError(
        response.status === 401
          ? "CODE 无效"
          : response.status === 503
            ? "访问控制尚未启用"
            : "暂时无法验证",
      );
      clearCode();
    } catch {
      setError("网络连接失败");
      clearCode();
    } finally {
      requestInFlight.current = false;
      setSubmitting(false);
    }
  }

  function applyDigits(startIndex: number, value: string) {
    const incoming = value.replace(/\D/g, "").slice(0, CODE_LENGTH - startIndex);
    if (!incoming) return;

    const nextDigits = [...digitsRef.current];
    incoming.split("").forEach((digit, offset) => {
      nextDigits[startIndex + offset] = digit;
    });
    digitsRef.current = nextDigits;
    nextDigits.forEach((digit, index) => {
      const input = inputRefs.current[index];
      if (input) input.value = digit;
    });
    setError("");
    window.setTimeout(
      () => focusDigit(Math.min(startIndex + incoming.length, CODE_LENGTH - 1)),
      0,
    );

    const candidate = nextDigits.join("");
    if (candidate.length === CODE_LENGTH) void verify(candidate);
  }

  function handleChange(index: number, event: ChangeEvent<HTMLInputElement>) {
    if (event.target.value) {
      applyDigits(index, event.target.value);
      return;
    }

    const nextDigits = [...digitsRef.current];
    nextDigits[index] = "";
    digitsRef.current = nextDigits;
    setError("");
  }

  function handlePaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/\d/.test(pasted)) return;
    event.preventDefault();
    applyDigits(index, pasted);
  }

  function handleDigitKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      applyDigits(index, event.key);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusDigit(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      focusDigit(index + 1);
    } else if (event.key === "Backspace" && !digitsRef.current[index] && index > 0) {
      event.preventDefault();
      const nextDigits = [...digitsRef.current];
      nextDigits[index - 1] = "";
      digitsRef.current = nextDigits;
      const previousInput = inputRefs.current[index - 1];
      if (previousInput) previousInput.value = "";
      focusDigit(index - 1);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verify(digitsRef.current.join(""));
  }

  return (
    <form className={styles.accessForm} onSubmit={handleSubmit} aria-busy={submitting}>
      <div className={styles.seatControl}>
        <div
          className={styles.seatSwitch}
          role="radiogroup"
          aria-label="你现在坐在哪个位置上"
          onKeyDown={handleSeatKeyDown}
        >
          <span aria-hidden="true" className={styles.seatThumb} data-seat={seat} />
          {SEATS.map((option) => (
            <button
              key={option.value}
              ref={(node) => { seatButtonRefs.current[option.value] = node; }}
              type="button"
              role="radio"
              aria-checked={seat === option.value}
              tabIndex={seat === option.value ? 0 : -1}
              onClick={() => setSeat(option.value)}
              className={`${styles.seatOption} ${seat === option.value ? styles.seatOptionOn : ""}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.codeGroup}>
        <p className={styles.codeLabel}>输入密码</p>
        <div className={`${styles.codeField} ${error ? styles.codeFieldError : ""}`}>
          {Array.from({ length: CODE_LENGTH }, (_, index) => (
            <input
              key={index}
              ref={(node) => { inputRefs.current[index] = node; }}
              aria-label={`访问码第 ${index + 1} 位`}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete={index === 0 ? "one-time-code" : "off"}
              autoFocus={index === 0}
              maxLength={1}
              defaultValue=""
              placeholder=" "
              disabled={submitting}
              onChange={(event) => handleChange(index, event)}
              onPaste={(event) => handlePaste(index, event)}
              onKeyDown={(event) => handleDigitKeyDown(index, event)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "access-error" : undefined}
              className={styles.codeCell}
            />
          ))}
        </div>
      </div>

      <div className={styles.errorSlot} aria-live="polite">
        {submitting ? <p className={styles.verifying}>正在确认</p> : null}
        {error ? <p id="access-error" role="alert">{error}</p> : null}
      </div>

      <button type="submit" className={styles.srOnly}>确认访问码</button>
    </form>
  );
}
