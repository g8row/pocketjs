// BOARD page — STUB, replaced by the board page agent (brief: apps/desk/DESIGN.md).
import { Text, View } from "@pocketjs/framework/components";
import { PW, PH } from "../ui.tsx";

export function BoardPage(props: { active: () => boolean }) {
  void props;
  return (
    <View class="items-center justify-center" style={{ width: PW, height: PH }}>
      <Text class="text-sm font-bold text-[#8a8a8a]">board · stub</Text>
    </View>
  );
}
