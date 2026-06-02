import { useEffect, useState } from "react";
import { getApiHealth } from "../server/healthClient";
import type { ApiHealth } from "../server/types";

type ApiHealthState =
  | { status: "checking"; data?: undefined }
  | { status: "ok"; data: ApiHealth }
  | { status: "offline"; data?: undefined };

export function useApiHealth(): ApiHealthState {
  const [state, setState] = useState<ApiHealthState>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;

    getApiHealth()
      .then((data) => {
        if (!cancelled) {
          setState({ status: data.status, data });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "offline" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
