import React from 'react';
import { render, screen } from '@testing-library/react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../renderer/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../renderer/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../renderer/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../renderer/components/ui/popover';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../renderer/components/ui/command';
import { Kbd, splitShortcut } from '../renderer/components/ui/kbd';

beforeAll(() => {
  (global as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = jest.fn();
});

describe('ui primitives', () => {
  it('renders tabs', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Alpha</TabsTrigger>
          <TabsTrigger value="b">Beta</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Content A</TabsContent>
      </Tabs>
    );
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Content A')).toBeTruthy();
  });

  it('renders tooltip trigger', () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(screen.getByText('Hover')).toBeTruthy();
  });

  it('renders dropdown menu content when open', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(screen.getByText('Item one')).toBeTruthy();
  });

  it('renders popover content when open', () => {
    render(
      <Popover open>
        <PopoverTrigger>Pop</PopoverTrigger>
        <PopoverContent>Popover body</PopoverContent>
      </Popover>
    );
    expect(screen.getByText('Popover body')).toBeTruthy();
  });

  it('renders command list and dialog', () => {
    const list = (
      <>
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandEmpty>None</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem>
              Do thing<CommandShortcut>⌘K</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </>
    );
    const { unmount } = render(<Command>{list}</Command>);
    expect(screen.getByText('Do thing')).toBeTruthy();
    unmount();
    render(
      <CommandDialog open onOpenChange={() => {}}>
        {list}
      </CommandDialog>
    );
    expect(screen.getByPlaceholderText('Search')).toBeTruthy();
  });

  it.each([
    ['⌘⇧P', ['⌘', '⇧', 'P']],
    ['Ctrl+K', ['Ctrl', 'K']],
    ['⌘K', ['⌘', 'K']],
    ['Esc', ['Esc']],
  ])('splits shortcut %s', (input, expected) => {
    expect(splitShortcut(input)).toEqual(expected);
  });

  it('renders Kbd keycaps', () => {
    const { container } = render(<Kbd keys="⌘⇧P" />);
    expect(container.querySelectorAll('kbd').length).toBe(3);
  });
});
