import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

import { showActionMenu } from '../../components/UI';
import type { PickedImage } from './attachments';

type ImageSource = 'library' | 'camera';

const denied = (what: string) => Alert.alert(`Allow access to ${what}`, `Talyn cannot use ${what} yet. You can allow it in your phone settings.`, [
  { text: 'Not now', style: 'cancel' }, { text: 'Open settings', onPress: () => { void Linking.openSettings(); } }]);

async function choose(source: ImageSource, onPicked: (assets: PickedImage[]) => void) {
  try {
    if (source === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) { denied('the camera'); return; }
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8 };
    const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync({ ...options, allowsMultipleSelection: true });
    if (!result.canceled) onPicked(result.assets);
  } catch {
    Alert.alert('Could not add the image', source === 'camera' ? 'The camera did not open. Try again.' : 'Your photos did not open. If you turned off photo access, allow it in your phone settings.');
  }
}

/** The attach menu of both composers: the photo library or the camera. */
export function showImagePicker(onPicked: (assets: PickedImage[]) => void) {
  showActionMenu('Attach an image', [
    { label: 'Photo library', onPress: () => { void choose('library', onPicked); } },
    { label: 'Take photo', onPress: () => { void choose('camera', onPicked); } },
  ]);
}
