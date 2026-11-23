// DECK page — STUB, replaced by the deck page agent (brief: apps/desk/DESIGN.md).
import { Text, View } from "@pocketjs/framework/components";
import { PW, PH } from "../ui.tsx";

export function DeckPage(props: { active: () => boolean }) {
  void props;
  return (
    <View class="items-center justify-center" style={{ width: PW, height: PH }}>
      <Text class="text-sm font-bold text-[#8a8a8a]">deck · stub</Text>
    </View>
  );
}
