import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import { SpaceGrotesk_500Medium } from '@expo-google-fonts/space-grotesk/500Medium';
import { SpaceGrotesk_600SemiBold } from '@expo-google-fonts/space-grotesk/600SemiBold';
import { useFonts } from 'expo-font';

export const fontAssets = {
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
  SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold,
  JetBrainsMono_400Regular, JetBrainsMono_500Medium,
};

/** True once the bundled fonts are ready. A load failure also answers true, so the app falls back to system fonts. */
export function useAppFonts() {
  const [loaded, error] = useFonts(fontAssets);
  return loaded || Boolean(error);
}
