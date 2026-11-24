// TEMPORARY: visual test of the ui.tsx kit on the tablet (registered as the "kit" pane). Removed before merge.
import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { Btn, C, Chip, Icon, KV, PANE_X, PANE_Y, Seg, Sheet, Slider, TBar, TBox, TSpark, Toggle } from "./ui.tsx";
import { ICON_NAMES } from "./nf.ts";

export function KitTest(props: { active: () => boolean }) {
  const [seg, setSeg] = createSignal("10m");
  const [tog, setTog] = createSignal(true);
  const [sl, setSl] = createSignal(0.78);
  const [sheet, setSheet] = createSignal(true);
  return (
    <View class="h-full flex-col gap-2 p-2" style={{ width: 406 }}>
      <View class="flex-row gap-2">
        <TBox title="LINUX CPU" rightIcon="cpu" w={190}>
          <Text class="text-2xl text-[#ededed]">12%</Text>
          <TSpark values={() => [1, 2, 3, 2, 4, 5, 3, 2, 3, 5, 6, 4, 3, 5, 7, 6, 4]} max={7} />
          <KV k="soc" v="44 °C" />
        </TBox>
        <TBox title="BAR" right="78%" hot grow>
          <TBar value={sl} cells={14} />
          <Text class="text-xs font-bold text-[#8a8a8a]">░█▁▃▅▇</Text>
        </TBox>
      </View>
      <View class="flex-row gap-2 items-center">
        <Btn label="linux" icon="restart" onPress={() => {}} />
        <Btn icon="pause" kind="primary" w={44} onPress={() => {}} />
        <Btn label="off" icon="power" kind="warn" onPress={() => setSheet(true)} />
        <Chip label="pocketdeck" on dot={C.ok} onPress={() => {}} />
      </View>
      <View class="flex-row gap-3 items-center">
        <Seg options={["1m", "10m", "1h"]} value={seg} onChange={setSeg} />
        <Toggle on={tog} onChange={setTog} />
        <Slider x={PANE_X + 8 + 150} y={PANE_Y + 8 + 160} w={120} value={sl} onChange={setSl} active={props.active} />
      </View>
      <View class="flex-row flex-wrap gap-[6]">
        {ICON_NAMES.slice(0, 30).map((n) => <Icon name={n} size="xl" />)}
      </View>
      <Sheet open={sheet} color={C.rose}>
        <Icon name="android" size="2xl" color={C.rose} />
        <View class="flex-1 flex-col">
          <Text class="text-base text-[#ededed]">reboot to android?</Text>
          <Text class="text-xs font-bold text-[#8a8a8a]">touch filters paused</Text>
        </View>
        <Btn label="cancel" h={34} onPress={() => setSheet(false)} />
        <Btn label="reboot" kind="danger" h={34} onPress={() => setSheet(false)} />
      </Sheet>
    </View>
  );
}
