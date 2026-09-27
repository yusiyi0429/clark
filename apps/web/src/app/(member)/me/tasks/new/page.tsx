import { CreateTaskScreen } from "@/components/tasks/CreateTaskScreen";
import { requireMember } from "@/lib/api/server";

export default async function NewTaskPage() {
  await requireMember("/me/tasks/new");
  return <CreateTaskScreen />;
}
