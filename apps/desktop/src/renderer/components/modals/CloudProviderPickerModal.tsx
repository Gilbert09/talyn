import { useProviderPicker } from '../../stores/providerPicker';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';

/**
 * Provider chooser shown when the workspace's default is "Ask every time" and
 * more than one cloud provider is connected. Mounted once at the app root;
 * driven by the `providerPicker` store (a promise-based `pickCloudProvider`).
 */
export function CloudProviderPickerModal() {
  const request = useProviderPicker((s) => s.request);
  const choose = useProviderPicker((s) => s.choose);

  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) choose(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run this task with…</DialogTitle>
          <DialogDescription>Choose which cloud provider should handle it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {request?.providers.map((p) => (
            <Button
              key={p.type}
              variant="outline"
              className="w-full justify-start"
              onClick={() => choose(p.type)}
            >
              {p.displayName}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
